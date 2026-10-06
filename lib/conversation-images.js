"use strict";
const fs = require("node:fs");
const path = require("node:path");
// Keep the last two rounds of explicit attachments available for follow-up questions.
// Live camera frames are never persisted or silently replayed as current observations.
function conversationImages(history, directory) {
  return history.map((message, index) => {
    if (
      index < history.length - 4 ||
      message.role !== "user" ||
      !message.attachments?.length
    )
      return message;
    const images = [];
    for (const image of message.attachments) {
      if (!/^[a-f0-9]{64}$/.test(image.id)) continue;
      const file = path.join(directory, image.id + ".jpg");
      if (!fs.existsSync(file) || fs.statSync(file).size > 256 * 1024) continue;
      images.push({
        type: "image_url",
        image_url: {
          url:
            "data:image/jpeg;base64," +
            fs.readFileSync(file).toString("base64"),
        },
      });
    }
    return images.length
      ? {
          ...message,
          content: [
            {
              type: "text",
              text:
                message.content + "（本轮历史上传的图片，不代表当前摄像头）",
            },
            ...images,
          ],
        }
      : message;
  });
}
module.exports = { conversationImages };
