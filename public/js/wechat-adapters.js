"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (text) => ($("wechatAdapterStatus").textContent = text);
  async function api(endpoint, body) {
    const response = await fetch(
      "/api/wechat/" + endpoint,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    const data = await window.readJSONResponse(response, "微信官方接口");
    if (!response.ok) throw Error(data.error);
    return data;
  }
  api("adapters")
    .then((data) => {
      $("wechatConfirmOfficial").checked = data.confirmSend;
      $("wechatCorpId").value = data.enterprise.id;
      $("wechatAgentId").value = data.enterprise.agentId;
      $("wechatPublicId").value = data.publicAccount.id;
    })
    .catch((error) => status(error.message));
  $("wechatAdaptersSave").onclick = async () => {
    try {
      await api("adapters", {
        confirmSend: $("wechatConfirmOfficial").checked,
        enterprise: {
          id: $("wechatCorpId").value.trim(),
          secret: $("wechatCorpSecret").value.trim(),
          agentId: $("wechatAgentId").value.trim(),
        },
        publicAccount: {
          id: $("wechatPublicId").value.trim(),
          secret: $("wechatPublicSecret").value.trim(),
        },
      });
      $("wechatCorpSecret").value = "";
      $("wechatPublicSecret").value = "";
      status("适配器已保存");
    } catch (error) {
      status(error.message);
    }
  };
  $("wechatOfficialSend").onclick = async () => {
    try {
      const request = {
        adapter: $("wechatOfficialAdapter").value,
        recipient: $("wechatOfficialRecipient").value.trim(),
        text: $("wechatOfficialText").value,
        operationId: crypto.randomUUID(),
      };
      let data = await api("official-send", request);
      if (data.confirmationRequired) {
        if (!window.confirm(`向 ${data.recipient} 发送：\n${data.text}`))
          return;
        data = await api("official-send", {
          ...request,
          confirmationId: data.confirmationId,
        });
      }
      status(data.text);
    } catch (error) {
      status(error.message);
    }
  };
})();
