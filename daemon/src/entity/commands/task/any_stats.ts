import disk_limit_service from "../../../service/disk_limit_service";
import Instance from "../../instance/instance";
import { ILifeCycleTask } from "../../instance/life_cycle";

// The disk usage scan runs for every running instance regardless of whether a
// quota (maxSpace) is configured — the usage is displayed in the instance
// overview/terminal header. Quota enforcement (auto-stop when full) only
// applies when maxSpace > 0 and is handled inside the service.
const CHECK_INTERVAL_MS = 1000 * 45;

export default class InstanceDiskCheckTask implements ILifeCycleTask {
  public status: number = 0;
  public name: string = "AnyInstanceStats";

  private task: any = null;

  async start(instance: Instance) {
    this.task = setInterval(() => {
      disk_limit_service.checkInstanceDiskSize(instance);
    }, CHECK_INTERVAL_MS);
  }

  async stop(instance: Instance) {
    clearInterval(this.task);
    instance.info = {
      ...instance.info,
      storageUsage: 0,
      // undefined when no quota is configured (frontend renders "∞ GiB")
      storageLimit: instance.config.docker?.maxSpace
        ? instance.config.docker.maxSpace
        : undefined
    };
  }
}
