<script setup lang="ts">
import { ref } from "vue";
import { t } from "@/lang/i18n";
import { dockerPortsArray } from "@/tools/common";
import { composeInfo } from "@/services/apis/fileManager";
import { message } from "ant-design-vue";

const props = defineProps<{
  dockerInfo?: IGlobalInstanceDockerConfig;
  daemonId?: string;
  instanceUuid?: string;
}>();

const open = ref(false);
// Compose 模式下从 compose 文件读取的展示信息
const composeInfoData = ref<{
  memory: number;
  networkMode: string;
  image: string;
  containerName: string;
} | null>(null);

const openDialog = () => {
  open.value = true;
  if (props.dockerInfo?.useCompose) {
    loadComposeInfo();
  }
};

const loadComposeInfo = async () => {
  if (!props.daemonId || !props.instanceUuid) return;
  try {
    const res = await composeInfo().execute({
      params: {
        daemonId: props.daemonId,
        uuid: props.instanceUuid
      }
    });
    if (res.value) {
      composeInfoData.value = {
        memory: res.value.memory,
        networkMode: res.value.networkMode,
        image: res.value.image,
        containerName: res.value.containerName
      };
    }
  } catch (err: any) {
    message.error(err?.message || String(err));
  }
};

const isComposeMode = () => props.dockerInfo?.useCompose === true;

const displayMemory = () => (isComposeMode() ? composeInfoData.value?.memory : props.dockerInfo?.memory) ?? 0;
const displayNetworkMode = () =>
  isComposeMode() ? composeInfoData.value?.networkMode : props.dockerInfo?.networkMode;
const displayImage = () => (isComposeMode() ? composeInfoData.value?.image : props.dockerInfo?.image);
const displayContainerName = () =>
  isComposeMode() ? composeInfoData.value?.containerName : props.dockerInfo?.containerName;

defineExpose({ openDialog });
</script>

<template>
  <a-modal v-model:open="open" centered :title="t('TXT_CODE_a7f6b0e0')" @ok="open = false">
    <a-descriptions :column="{ md: 2, sm: 2, xs: 1 }">
      <a-descriptions-item :label="t('TXT_CODE_dd238854')">
        {{ displayMemory() }}MB
      </a-descriptions-item>
      <a-descriptions-item :label="t('TXT_CODE_efcef926')">
        {{ displayNetworkMode() || t("TXT_CODE_composeInfoNotSet") }}
      </a-descriptions-item>
      <a-descriptions-item :label="t('TXT_CODE_77000411')">
        {{ displayImage() || t("TXT_CODE_composeInfoNotSet") }}
      </a-descriptions-item>
      <a-descriptions-item :label="t('TXT_CODE_c3a3b6b1')">
        {{ displayContainerName() || t("TXT_CODE_composeInfoNotSet") }}
      </a-descriptions-item>
      <a-descriptions-item v-if="isComposeMode()" :label="t('TXT_CODE_d32301c1')">
        <div>NotSupport</div>
      </a-descriptions-item>
      <a-descriptions-item v-else-if="props.dockerInfo?.ports" :label="t('TXT_CODE_d32301c1')">
        <div>
          <div
            v-for="(item, index) in dockerPortsArray(props?.dockerInfo.ports ?? [])"
            :key="index"
            style="margin-bottom: 2px"
          >
            <span>{{ t("TXT_CODE_8dfc41ef") }}: {{ item.host }}</span>
            <span style="margin-left: 6px">{{ t("TXT_CODE_8f8103b7") }}: {{ item.container }}</span>
            <span style="margin-left: 8px">
              <a-tag color="green">{{ item.protocol.toUpperCase() }}</a-tag>
            </span>
          </div>
        </div>
      </a-descriptions-item>
    </a-descriptions>
  </a-modal>
</template>
