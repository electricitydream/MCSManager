import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "util";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import { checkFilePath } from "../tools/filepath";
import { ConsumerQueue } from "../utils/queue";
import { sleep } from "../utils/sleep";
import logger from "./log";

const execPromise = promisify(exec);

interface IDiskLimitItem {
  instance: Instance;
  workspace: string;
  maxSpace: number;
}

// du -s --block-size=1M /docker-volumes/app1-logs | cut -f1
class DiskLimitService {
  private readonly queue = new ConsumerQueue<IDiskLimitItem>(2048);
  private task: NodeJS.Timeout | null = null;
  private checking: boolean = false;
  private concurrent = 2;

  constructor() {
    this.task = setInterval(() => {
      this.#startCheck();
    }, 1000 * 10);
  }

  async checkInstanceDiskSize(instance: Instance) {
    const maxSpace = Number(instance.config.docker.maxSpace);
    // maxSpace <= 0 (default 0 / unset / negative) means the quota feature is
    // disabled — but we still scan the usage for display purposes; the
    // auto-stop logic inside `checkDiskNow` only fires when storageLimit > 0.
    const workspace = instance.absoluteCwdPath();
    this.queue.push({
      key: instance.instanceUuid,
      item: {
        instance,
        workspace,
        maxSpace
      }
    });
    this.#startCheck();
  }

  async #startCheck() {
    if (this.checking) return;
    this.checking = true;
    try {
      const promises = [];
      for (let i = 0; i < this.concurrent; i++) {
        const item = this.queue.pop();
        if (item) {
          promises.push(
            this.checkDiskNow(item).catch((error) => {
              logger.warn(
                `Disk usage check failed for instance ${item.instance.instanceUuid}`,
                error
              );
            })
          );
        }
      }
      await Promise.all(promises);
    } finally {
      this.checking = false;
    }
  }

  async #stopInstance(instance: Instance) {
    if (instance.status() === Instance.STATUS_RUNNING) {
      const startCount = instance.startCount;
      instance.execPreset("stop");
      await sleep(1000 * 10);
      if (instance.status() !== Instance.STATUS_STOP && startCount === instance.startCount) {
        instance.println("ERROR", $t("TXT_CODE_8418e7fe"));
        instance
          .execPreset("kill")
          .then(() => {})
          .catch((err) => {});
      }
    }
  }

  private getCheckDefaultValue(instance: Instance, maxSpace = 0) {
    instance.info.storageUsage = 0;
    // No quota configured (maxSpace <= 0): storageLimit is undefined so the
    // frontend can render the "unlimited" (∞) display.
    instance.info.storageLimit = maxSpace > 0 ? maxSpace : undefined;
    return {
      isFull: false,
      storageLimit: maxSpace,
      storageUsage: 0
    };
  }

  public async checkDiskNow(item: IDiskLimitItem, autoStop: boolean = true) {
    const { instance, workspace, maxSpace } = item;

    // global instance is not limited by disk space
    if (instance.isGlobalInstance() || workspace === "/" || workspace === "\\") {
      return this.getCheckDefaultValue(instance, maxSpace);
    }

    // Disk limit is not supported on Windows
    if (os.platform() === "win32") {
      return this.getCheckDefaultValue(instance, maxSpace);
    }

    // There was already an initial check on the working directory when saving,
    // but we double-check here.
    if (!checkFilePath(workspace) || !fs.existsSync(workspace)) {
      return this.getCheckDefaultValue(instance, maxSpace);
    }

    const command = `du -s --block-size=1M "${workspace}"`;
    const { stdout } = await execPromise(command);

    const diskUsageSizeMb = Number(String(stdout.split("/")[0]).replaceAll("\t", "").trim());

    if (isNaN(Number(diskUsageSizeMb))) {
      instance.info.storageUsage = 0;
      // GB to bytes; undefined when no quota is configured (unlimited)
      instance.info.storageLimit = maxSpace > 0 ? convertGBToBytes(maxSpace) : undefined;
    } else {
      instance.info.storageUsage = diskUsageSizeMb * 1024 * 1024; // MB to bytes
      instance.info.storageLimit = maxSpace > 0 ? convertGBToBytes(maxSpace) : undefined;
    }

    const storageLimit = instance.info.storageLimit;
    const storageUsage = instance.info.storageUsage;

    // Quota enforcement only applies when a positive limit is configured.
    const hasQuota = typeof storageLimit === "number" && storageLimit > 0;

    if (autoStop && hasQuota) {
      if (storageUsage >= storageLimit) {
        for (let i = 0; i < 3; i++) {
          instance.println(
            "WARNING",
            $t("TXT_CODE_f94734d8", {
              storageLimit: convertBytesToGB(storageLimit!),
              storageUsage: convertBytesToGB(storageUsage)
            })
          );
          instance.println("WARNING", $t("TXT_CODE_d448d98d"));
          await sleep(200);
        }
        this.#stopInstance(instance);
      }
    }

    return {
      isFull: hasQuota && storageUsage >= storageLimit!,
      storageLimit: hasQuota ? convertBytesToGB(storageLimit!) : 0,
      storageUsage: convertBytesToGB(storageUsage)
    };
  }
}

export function convertBytesToGB(bytes: number) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

export function convertGBToBytes(gb: number) {
  return Number((gb * 1024 * 1024 * 1024).toFixed(2));
}

export default new DiskLimitService();
