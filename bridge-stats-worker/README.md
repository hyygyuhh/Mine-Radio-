# Mineradio Bridge 统计 Worker

已部署到 Cloudflare（挂在主站路径下，避免子域 IPv6 解析问题）：

- **看数据**：https://mineradio.art/bridge/stats  
- 心跳：`POST https://mineradio.art/bridge/heartbeat`

扩展 `STATS_BASE_URL` 设为 `https://mineradio.art`，重载 Bridge 即可。

## 更新部署

```powershell
cd d:\Users\z1590\Desktop\Mine-Radio--main\bridge-stats-worker
npm run deploy
```
