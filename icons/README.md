从 `build/icon.png` 生成：

```powershell
node web/scripts/generate-icons.js
```

## 赞赏收款码

登录页「赞赏支持」弹窗使用二合一收款码：

- `donate-qr.png` — 微信 / 支付宝通用赞赏码

也可在 `index.html` 中修改 `DONATE_QR_CONFIG.qr` 指向其他路径或 CDN 地址。
