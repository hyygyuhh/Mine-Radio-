# Mineradio Bridge

Chrome / Edge 扩展，为 [Mineradio 网页版](https://mineradio.art/) 提供本机音乐 Cookie 代理。

- 安装说明：https://mineradio.art/bridge-install.html  
- 隐私政策：https://mineradio.art/privacy.html  
- 更新日志：https://mineradio.art/changelog.html  
- 联系邮箱：support@mineradio.cn  

## 安装（用户）

完整图文步骤见：**https://mineradio.art/bridge-install.html**

简要：
1. 从网盘下载并解压本扩展（夸克 / 百度，链接见安装说明页）
2. 打开 `chrome://extensions`（或 Edge 扩展页）→ 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本文件夹（需含 `manifest.json`）
4. 在浏览器登录 [网易云](https://music.163.com) / [QQ 音乐](https://y.qq.com) / [酷狗](https://www.kugou.com)
5. 点扩展图标「刷新状态」，再打开 https://mineradio.art/ 重新检测

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `cookies` | 读取 / 清除音乐平台登录 Cookie |
| `host_permissions` | 向音乐平台 API 发起请求 |
| `storage` | 缓存轻量状态与匿名安装 ID |
| `alarms` | 每日匿名心跳（仅安装 ID + 版本号） |

登录 Cookie 与听歌记录不会上传到 Mineradio 服务器。网页点「退出」时会经扩展清除对应平台 Cookie。

## 匿名统计

可选心跳上报随机安装 ID 与版本号，用于活跃与版本分布。汇总：https://mineradio.art/bridge/stats  

## 开发结构

- `background.js` — Service Worker
- `content-bridge.js` — 页面 ↔ 扩展
- `popup.html` / `popup.js` — 扩展弹窗
- `api/` — 音乐源与 Cookie 代理

修改后请在扩展管理页点击「重新加载」，并重新打包 zip 再分发。
