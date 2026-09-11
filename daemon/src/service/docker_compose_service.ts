import { execFile } from "child_process";
import fs from "fs-extra";
import path from "path";
import { promisify } from "util";
import yaml from "yaml";
import Instance from "../entity/instance/instance";
import { resolveDockerUserValue } from "../tools/system_user";
import logger from "./log";

const execFileAsync = promisify(execFile);

/**
 * Docker Compose 操作工具
 * 用于 MCSManager 实例以 compose 模式管理容器
 */
export class DockerComposeService {
  /**
   * 受管的 compose 目录：data/InstanceCompose
   * 每个实例的 compose 文件统一集中到 data/InstanceCompose/<uuid>.yml
   */
  static getManagedComposeDir(): string {
    return path.join(process.cwd(), "data", "InstanceCompose");
  }

  /**
   * 受管的 compose 文件路径：data/InstanceCompose/<uuid>.yml
   */
  static getManagedComposePath(instance: Instance): string {
    return path.join(this.getManagedComposeDir(), `${instance.instanceUuid}.yml`);
  }

  /**
   * 迁移：若受管位置不存在，但实例工作目录里有 compose 文件，则复制到受管位置。
   * 注意：compose 内相对路径（如 ./data:/app）相对「compose 文件所在目录」解析，
   * 迁移后基准变为 InstanceCompose 目录，需用户在文件里使用绝对路径适配。
   */
  static async migrateComposeFile(instance: Instance): Promise<void> {
    const managed = this.getManagedComposePath(instance);
    if (await fs.pathExists(managed)) return;
    const cwd = instance.absoluteCwdPath();
    const possibleNames = ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"];
    for (const name of possibleNames) {
      const src = path.join(cwd, name);
      if (await fs.pathExists(src)) {
        await fs.mkdirp(this.getManagedComposeDir());
        await fs.copy(src, managed);
        logger.info(`[DockerCompose] Migrated compose file ${src} -> ${managed}`);
        return;
      }
    }
  }

  /**
   * 检查 compose 文件是否存在（受管位置，必要时从 cwd 迁移）
   */
  static async hasComposeFile(instance: Instance): Promise<boolean> {
    await this.migrateComposeFile(instance);
    return fs.pathExists(this.getManagedComposePath(instance));
  }

  /**
   * 获取 compose 文件路径（受管位置，必要时从 cwd 迁移）
   */
  static async getComposeFilePath(instance: Instance): Promise<string> {
    await this.migrateComposeFile(instance);
    const managed = this.getManagedComposePath(instance);
    if (await fs.pathExists(managed)) return managed;
    throw new Error(
      `No compose file found at ${managed} nor in the instance working directory`
    );
  }

  /**
   * 读取 compose 文件内容
   */
  static async readComposeContent(instance: Instance): Promise<{ text: string; exists: boolean }> {
    await this.migrateComposeFile(instance);
    const managed = this.getManagedComposePath(instance);
    if (await fs.pathExists(managed)) {
      return { text: await fs.readFile(managed, "utf-8"), exists: true };
    }
    return { text: "", exists: false };
  }

  /**
   * 保存 compose 文件内容（校验 YAML 合法且为单服务）
   */
  static async saveComposeContent(instance: Instance, text: string): Promise<{ services: string[] }> {
    let parsed: any;
    try {
      parsed = yaml.parse(text);
    } catch (e: any) {
      throw new Error(`Invalid YAML: ${e?.message || e}`);
    }
    if (!parsed || typeof parsed !== "object" || !parsed.services || typeof parsed.services !== "object") {
      throw new Error("Compose file must define a top-level 'services' mapping");
    }
    const services = Object.keys(parsed.services);
    if (services.length !== 1) {
      throw new Error(`Expected exactly one service, found ${services.length}: ${services.join(", ")}`);
    }
    await fs.mkdirp(this.getManagedComposeDir());
    await fs.writeFile(this.getManagedComposePath(instance), text, "utf-8");
    logger.info(`[DockerCompose] Saved compose file for instance ${instance.instanceUuid}`);
    return { services };
  }

  /**
   * 解析 compose 文件，获取服务名列表
   */
  static async getServiceNames(instance: Instance): Promise<string[]> {
    const filePath = await this.getComposeFilePath(instance);
    const content = await fs.readFile(filePath, "utf-8");
    try {
      const parsed = yaml.parse(content);
      if (!parsed || typeof parsed !== "object") return [];
      const services = parsed.services;
      if (!services || typeof services !== "object") return [];
      return Object.keys(services);
    } catch (err) {
      logger.error(`Failed to parse compose file: ${filePath}`, err);
      try {
        const { stdout } = await execFileAsync("docker", ["compose", "config", "--services"], {
          cwd: instance.absoluteCwdPath()
        });
        return stdout.trim().split("\n").filter(Boolean);
      } catch (execErr) {
        throw new Error(`Failed to parse compose file and docker compose not available: ${execErr}`);
      }
    }
  }

  /**
   * 解析 compose 文件，获取服务数量
   */
  static async getServiceCount(instance: Instance): Promise<number> {
    const names = await this.getServiceNames(instance);
    return names.length;
  }

  /**
   * 解析 compose 文件，提取展示用的资源限制信息（单服务）：
   * - memory: services.<name>.deploy.resources.limits.memory，单位 M（默认 0）
   * - networkMode: services.<name>.network_mode，或 networks 的第一个 key（自定义网络）
   * - image: services.<name>.image
   * - containerName: services.<name>.container_name
   * 端口映射不支持，由前端显示 NotSupport
   */
  static async readComposeInfo(instance: Instance): Promise<{
    memory: number;
    networkMode: string;
    image: string;
    containerName: string;
    portsNotSupported: true;
  }> {
    const { text, exists } = await this.readComposeContent(instance);
    const info = {
      memory: 0,
      networkMode: "",
      image: "",
      containerName: "",
      portsNotSupported: true as const
    };
    if (!exists) return info;

    let parsed: any;
    try {
      parsed = yaml.parse(text);
    } catch (err: any) {
      logger.warn(`[DockerCompose] Failed to parse compose file for info: ${err?.message || err}`);
      return info;
    }
    if (!parsed?.services || typeof parsed.services !== "object") return info;

    const serviceName = Object.keys(parsed.services)[0];
    const service = parsed.services[serviceName];
    if (!service || typeof service !== "object") return info;

    // memory: deploy.resources.limits.memory, e.g. "2048M" / "2G" / 2048
    const rawMemory = service?.deploy?.resources?.limits?.memory;
    info.memory = this.parseMemoryToMB(rawMemory);

    // network_mode: host/bridge/none; or networks (list short syntax or mapping)
    if (typeof service.network_mode === "string" && service.network_mode) {
      info.networkMode = service.network_mode;
    } else if (Array.isArray(service.networks) && service.networks.length > 0) {
      // short syntax: networks: [name1, name2]
      const first = service.networks[0];
      if (typeof first === "string" && first) info.networkMode = first;
    } else if (service.networks && typeof service.networks === "object") {
      // long syntax: networks: {name: {...}}
      const networkName = Object.keys(service.networks)[0];
      if (networkName) info.networkMode = networkName;
    }

    if (typeof service.image === "string") info.image = service.image;
    if (typeof service.container_name === "string") info.containerName = service.container_name;
    return info;
  }

  /**
   * 将 docker/compose 的 memory 值换算为 MB
   * 支持: 2048 / "2048M" / "2G" / "512m" / "1.5g" / "256K" / "1B" 等形式
   */
  private static parseMemoryToMB(raw: unknown): number {
    if (raw == null) return 0;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      // 纯数字按 compose 语义视为 bytes
      return Math.round(raw / (1024 * 1024));
    }
    if (typeof raw !== "string") return 0;
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgGtT]?)[bB]?$/);
    if (!m) return 0;
    const value = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const multipliers: Record<string, number> = {
      "": 1 / (1024 * 1024), // bytes
      k: 1 / 1024,
      m: 1,
      g: 1024,
      t: 1024 * 1024
    };
    return Math.round(value * multipliers[unit]);
  }

  /**
   * 获取 override 文件路径
   * 存放在 data/InstanceCompose/override/<instance_uuid>.yml
   * 独立分类目录，避免污染 InstanceConfig（上游代码假设该目录内全部为 <uuid>.json 文件）
   */
  static getOverrideFilePath(instance: Instance): string {
    const overrideDir = path.join(process.cwd(), "data", "InstanceCompose", "override");
    return path.join(overrideDir, `${instance.instanceUuid}.yml`);
  }

  /**
   * 生成 compose override 文件：
   * - 注入 mcsmanager.instance.uuid label，使容器可被 takeoverContainer() 自动接管
   * - 强制 tty + stdin_open，保证 Web 控制台（仿终端 attach）可正常读写
   */
  static async generateOverrideFile(instance: Instance, serviceName: string): Promise<string> {
    const overridePath = this.getOverrideFilePath(instance);
    const overrideDir = path.dirname(overridePath);
    await fs.mkdirs(overrideDir);

    // Resolve runAs to a docker user value; empty -> key omitted entirely
    const dockerUser = await resolveDockerUserValue(instance.config.runAs);

    const serviceOverride: Record<string, any> = {
      tty: true,
      stdin_open: true,
      labels: {
        "mcsmanager.instance.uuid": instance.instanceUuid
      }
    };
    if (dockerUser) {
      serviceOverride.user = dockerUser;
    }

    const overrideContent = yaml.stringify({
      services: {
        [serviceName]: serviceOverride
      }
    });

    await fs.writeFile(overridePath, overrideContent, "utf-8");
    logger.info(
      `[DockerCompose] Generated override file for instance ${instance.instanceUuid}, service: ${serviceName}`
    );
    return overridePath;
  }

  /**
   * 删除 override 文件（实例删除时调用）
   */
  static removeOverrideFile(instance: Instance): void {
    const overridePath = this.getOverrideFilePath(instance);
    if (fs.existsSync(overridePath)) {
      fs.removeSync(overridePath);
      logger.info(`[DockerCompose] Removed override file for instance ${instance.instanceUuid}`);
    }
  }

  /**
   * 检测 compose 模式是否可用（服务数 == 1）
   */
  static async checkComposeSingle(instance: Instance): Promise<{ valid: boolean; count: number; error?: string }> {
    if (!(await this.hasComposeFile(instance))) {
      return {
        valid: false,
        count: 0,
        error: `No compose file found. Edit the compose file in the "Compose 编辑器" tab`
      };
    }
    const count = await this.getServiceCount(instance);
    if (count === 0) {
      return { valid: false, count: 0, error: "No services defined in compose file" };
    }
    if (count > 1) {
      return { valid: false, count, error: `Compose file has ${count} services, only single-service compose is supported` };
    }
    return { valid: true, count: 1 };
  }

  /**
   * Build common docker compose args:
   * -f managed compose file, optional -f override file, --project-directory pinned to
   * the instance working dir so relative paths and the project name behave exactly as
   * if the compose file still lived in the working directory.
   */
  private static buildComposeArgs(instance: Instance, overrideFile?: string): string[] {
    const cwd = instance.absoluteCwdPath();
    return [
      "compose",
      "-f",
      this.getManagedComposePath(instance),
      ...(overrideFile ? ["-f", overrideFile] : []),
      "--project-directory",
      cwd
    ];
  }

  /**
   * 执行 docker compose up -d --force-recreate
   * 使用双 -f: 受管 compose 文件 + override 文件(注入 label)
   */
  static async up(instance: Instance, overrideFile?: string): Promise<void> {
    const cwd = instance.absoluteCwdPath();
    const args = [...this.buildComposeArgs(instance, overrideFile), "up", "-d", "--force-recreate"];
    logger.info(`[DockerCompose] Up instance ${instance.instanceUuid} in ${cwd}${overrideFile ? " + override" : ""}`);

    const { stdout, stderr } = await execFileAsync("docker", args, { cwd });
    if (stderr) {
      logger.warn(`[DockerCompose] up stderr: ${stderr}`);
    }
    logger.info(`[DockerCompose] up stdout: ${stdout}`);
  }

  /**
   * 获取 compose 项目的第一个运行容器 ID
   */
  static async getMainContainerId(instance: Instance): Promise<string | null> {
    const cwd = instance.absoluteCwdPath();
    try {
      const args = [...this.buildComposeArgs(instance), "ps", "-q"];
      const { stdout } = await execFileAsync("docker", args, { cwd });
      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return null;
      return lines[0].trim();
    } catch (err) {
      logger.error(`[DockerCompose] Failed to get container ID for instance ${instance.instanceUuid}`, err);
      return null;
    }
  }

  /**
   * 执行 docker compose stop (仅停止,保留容器)
   * 需要双 -f 保持与 up 一致的项目定义
   */
  static async stop(instance: Instance, overrideFile?: string): Promise<void> {
    const cwd = instance.absoluteCwdPath();
    logger.info(`[DockerCompose] Stop instance ${instance.instanceUuid} in ${cwd}`);

    const args = [...this.buildComposeArgs(instance, overrideFile), "stop"];
    const { stdout, stderr } = await execFileAsync("docker", args, { cwd });
    if (stderr) {
      logger.warn(`[DockerCompose] stop stderr: ${stderr}`);
    }
    logger.info(`[DockerCompose] stop stdout: ${stdout}`);
  }

  /**
   * 执行 docker compose down (停止并移除容器/网络)
   * 需要双 -f 保持与 up 一致的项目定义
   */
  static async down(instance: Instance, overrideFile?: string): Promise<void> {
    const cwd = instance.absoluteCwdPath();
    logger.info(`[DockerCompose] Down instance ${instance.instanceUuid} in ${cwd}`);

    const args = [...this.buildComposeArgs(instance, overrideFile), "down"];
    const { stdout, stderr } = await execFileAsync("docker", args, { cwd });
    if (stderr) {
      logger.warn(`[DockerCompose] down stderr: ${stderr}`);
    }
    logger.info(`[DockerCompose] down stdout: ${stdout}`);
  }

  /**
   * 执行 docker compose restart
   */
  static async restart(instance: Instance): Promise<void> {
    const cwd = instance.absoluteCwdPath();
    logger.info(`[DockerCompose] Restart instance ${instance.instanceUuid} in ${cwd}`);

    const args = [...this.buildComposeArgs(instance), "restart"];
    const { stdout, stderr } = await execFileAsync("docker", args, { cwd });
    if (stderr) {
      logger.warn(`[DockerCompose] restart stderr: ${stderr}`);
    }
    logger.info(`[DockerCompose] restart stdout: ${stdout}`);
  }

  /**
   * 检查 docker compose 是否可用
   */
  static async isDockerComposeAvailable(): Promise<boolean> {
    try {
      await execFileAsync("docker", ["compose", "version"]);
      return true;
    } catch {
      return false;
    }
  }
}
