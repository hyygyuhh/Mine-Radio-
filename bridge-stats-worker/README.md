# Mineradio Bridge 统计 Worker

已部署到 Cloudflare（挂在主站路径下，避免子域 IPv6 解析问题）：

- **看数据**：https://mineradio.art/bridge/stats （需登录；`?format=json` 同样要登录）
- 心跳：`POST https://mineradio.art/bridge/heartbeat`（不用登录）

访问密码放在 Worker Secret 里，不要写进代码。请用一长串随机字符：

```powershell
npx wrangler secret put STATS_PASSWORD
npm run deploy
```

登录后 30 天内不用重复输入。同一地址连续输错 8 次会锁定 15 分钟。

扩展 `STATS_BASE_URL` 设为 `https://mineradio.art`，重载 Bridge 即可。

## 更新部署

```powershell
cd d:\Users\z1590\Desktop\Mine-Radio--main\bridge-stats-worker
npm run deploy
```
