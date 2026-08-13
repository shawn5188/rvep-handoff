# AGX Orin + ZED-X + ZED Link Duo 安裝 SOP

> **更新日期**：2026-05-17  
> **驗證硬體**：NVIDIA Jetson AGX Orin DevKit + ZED Link Duo Capture Card (MAX96712) + ZED-X × 2  
> **驗證軟體**：JetPack 6.2.2 / L4T R36.5 / ZED SDK 5.3 / ZED Link driver 1.4.2

本文件為**從零裝起**到「相機 V4L2 出現」的完整步驟，含過程踩坑的修正。日後客戶現場部署或重灌 Orin 都照這份做即可。

---

## 1. 前置條件

### 硬體
- NVIDIA Jetson AGX Orin DevKit（已預灌 L4T，本文件假設 R36.5）
- ZED Link Duo Capture Card（已插入 DevKit Camera connector 並鎖上 3 顆螺絲）
- 1–2 顆 ZED-X 相機（透過 GMSL2 排線接 Duo Capture Card channel 0 / 1）
- 顯示器（**DisplayPort 才有畫面，HDMI 無效**）
- RJ45 網路線（不要靠 Wi-Fi 跑安裝）
- USB 鍵盤、滑鼠
- 已建立 `mirdc` 使用者帳號（或同等 sudo 權限帳號）

### 網路
- 與 backend / Livekit 同 LAN（本範例 `192.168.68.67`，server01 在 `192.168.68.68`）
- 可選 Tailscale 遠端管理（本範例 `100.105.22.128`）

### SSH（從開發機端）
```bash
# 確認 SSH key-based 登入
ssh mirdc@192.168.68.67 "uname -a"
```
若還沒設 key-based：在開發機跑 `ssh-copy-id mirdc@192.168.68.67`。

---

## 2. 確認 BSP 版本

```bash
ssh mirdc@192.168.68.67
cat /etc/nv_tegra_release
```

預期輸出包含：
```
# R36 (release), REVISION: 5.0, ...
# KERNEL_VARIANT: oot
```

→ 對應 **JetPack 6.2.2 / L4T 36.5**。後面下載 ZED SDK 與 driver 要選對應版本。

---

## 3. 安裝 nvidia-jetpack meta-package

> 這一步不裝會缺很多開發工具（CUDA tools、TensorRT 等）。雖然 BSP 已預灌，但 meta-package 提供 dev headers / samples / driver。

```bash
sudo apt update
sudo apt install -y nvidia-jetpack libqt5core5a curl wget v4l-utils zstd
```

下載量約 100–500 MB，依現有狀態。

---

## 4. 安裝 ZED SDK

### 4.1 下載
ZED SDK 不能透過 anonymous CDN 直拉（會回 HTML）。**用瀏覽器**從官網下載：

1. 開 [https://www.stereolabs.com/developers/release](https://www.stereolabs.com/developers/release)
2. 點 **「ZED SDK for JetPack 6.2.2 (L4T 36.5)」** 區塊（不是 6.1/6.2 那個）
3. 下載到本機 `~/Downloads/ZED_SDK_Tegra_L4T36.5_v5.3.0.zstd.run`（約 82 MB）

從本機 SCP 到 Orin：
```bash
scp ~/Downloads/ZED_SDK_Tegra_L4T36.5_v5.3.0.zstd.run mirdc@192.168.68.67:~/ZED_SDK.run
ssh mirdc@192.168.68.67 "chmod +x ~/ZED_SDK.run"
```

### 4.2 安裝（自動化）

**踩坑教訓**：ZED SDK installer 是 makeself self-extracting，有 5–10 個 interactive prompts（accept license / install samples / install drivers / Python API / Optimize AI）。
- **不要**用 `-- silent` flag — Stereolabs 5.3 installer 不認識
- **不要**用 `sudo` 直接跑 — installer 會拒絕 root，要 mirdc 身分跑、內部自己 elevate
- `yes "y"` pipe 不夠，因為 license preview 用 `less` pager 要按 `q` 才繼續

**正確做法**：用 `expect` 自動回答所有 prompts。

在 Orin 上建 `~/install-zed-sdk.sh`：

```bash
#!/bin/bash
set -uo pipefail
read -rsp "mirdc password: " PASS </dev/tty; echo

sudo apt install -y expect

cat > /tmp/zed_install.exp <<EOF
#!/usr/bin/expect -f
set timeout 1800
log_user 1
set env(PAGER) "cat"
set env(DEBIAN_FRONTEND) "noninteractive"
set sudo_pass "${PASS}"
spawn /home/mirdc/ZED_SDK.run
expect {
  -re {password for mirdc|\[sudo\] password} { send "\$sudo_pass\r"; exp_continue }
  -re {EULA|license.*accept|Do you accept|accept the License|accept this license} { send "Y\r"; exp_continue }
  -re {press q|Press q|---more---|\(END\)} { send "q"; exp_continue }
  -re {press.*Enter|Press.*ENTER|to continue|Enter to} { send "\r"; exp_continue }
  -re {Optimize.*AI|optimize.*Module|Skip the AI} { send "n\r"; exp_continue }
  -re {Python API|Python module} { send "Y\r"; exp_continue }
  -re {Install.*Sample|Samples} { send "Y\r"; exp_continue }
  -re {Install.*Driver|ZED-X|ZED X} { send "Y\r"; exp_continue }
  -re {Static or Dynamic|static} { send "1\r"; exp_continue }
  -re {\(Y/n\)|\[Y/n\]} { send "Y\r"; exp_continue }
  -re {\(y/N\)|\[y/N\]} { send "n\r"; exp_continue }
  eof { puts "\nINSTALLER_DONE" }
  timeout { puts "\nINSTALLER_TIMEOUT"; exit 1 }
}
EOF
chmod 600 /tmp/zed_install.exp
unset PASS

/usr/bin/expect /tmp/zed_install.exp
shred -u /tmp/zed_install.exp 2>/dev/null || rm -f /tmp/zed_install.exp
```

跑：
```bash
chmod +x ~/install-zed-sdk.sh
bash ~/install-zed-sdk.sh
```

預估 5–15 分鐘。完成後驗證：
```bash
ls /usr/local/zed/   # 應該有 doc / drivers / firmware / include / lib / samples / tools 等
```

### 4.3 ZED SDK 安裝後狀態

此時：
- `/usr/local/zed/` 完整 ✅
- 但**仍然沒有** `/dev/video0` — 因為 GMSL kernel driver **不在 ZED SDK 內**，要另外裝（下一節）

---

## 5. 安裝 ZED Link Duo Driver（GMSL kernel module）

### 5.1 下載

**踩坑教訓**：
- driver 不在 `https://www.stereolabs.com/developers/release` — 在另一個頁面
- 檔名是 `stereolabs-zedlink-duo_*.deb`，不是 `stereolabs-zedx_*.deb`
- URL 完全鎖在 Stereolabs React 內部，不能用 curl / wget 直拉

**做法**：用瀏覽器下載。

1. 開 [https://www.stereolabs.com/developers/drivers](https://www.stereolabs.com/developers/drivers)
2. scroll 找 **ZED Link Duo** 區塊
3. 找 **「JetPack 6.2.2 / L4T 36.5」**那一行（**不要選 RT 版** — Real-Time kernel 一般用不到）
4. 點 **Download**
5. 下載檔案：`stereolabs-zedlink-duo_1.4.2-LI-MAX96712-L4T36.5.0_arm64.deb`（約 655 KB）

SCP 到 Orin：
```bash
scp ~/Downloads/stereolabs-zedlink-duo_*.deb \
    mirdc@192.168.68.67:~/stereolabs-zedlink-duo.deb
```

### 5.2 安裝

```bash
ssh mirdc@192.168.68.67
sudo dpkg -i ~/stereolabs-zedlink-duo.deb
sudo apt install -f -y   # fix any missing deps
sudo systemctl daemon-reload
sudo systemctl restart zed_x_daemon
```

### 5.3 重啟（**必須**）

GMSL2 kernel module 要 reboot 才會完整載入：

```bash
sudo reboot
```

---

## 6. 驗證相機

重啟後 SSH 回去：

```bash
# 1. driver 載入訊息
sudo dmesg | grep -iE "zedx|max96|stereolabs"
# 應該看到 zedx / max96712 / sensor 等正常 init 訊息

# 2. V4L2 裝置
ls /dev/video*
# 應該看到 /dev/video0 /dev/video1（兩顆 ZED-X 各一個 V4L2 device）

v4l2-ctl --list-devices
# 應該看到具名的 ZED-X 條目

# 3. zed_x_daemon
systemctl status zed_x_daemon
# Active: active (running)

# 4. ZED 官方工具預覽（需 X11 forwarding 或 NoMachine 連桌面）
cd /usr/local/zed/tools
./ZED_Explorer
# 應該開窗顯示雙鏡頭即時影像
```

---

## 7. 常見問題排查

| 症狀 | 可能原因 | 修法 |
|------|---------|------|
| 安裝 SDK 報 `Syntax error: redirection unexpected` | 下載的不是真 binary（HTML redirect 被當 shell script 跑） | 確認從 stereolabs.com 用瀏覽器下載，檔案 ≥ 80 MB |
| Installer 拒絕 root | ZED SDK installer 拒絕 `sudo ./ZED_SDK.run` | 改用 mirdc 跑，installer 內部自己會跳 sudo prompt |
| dpkg 報 dependency 缺失 | nvidia-jetpack / libqt5core5a 沒裝 | `sudo apt install -f -y` |
| `/dev/video0` 沒出現 | driver 沒 reboot 載入 | `sudo reboot` |
| `ZED_Explorer` 報 `No ZED camera detected` | 排線沒接好 / channel 順序錯 | 拔插 GMSL2 排線 → `sudo systemctl restart zed_x_daemon` 或重啟 |
| dmesg 看到 max96712 init 但 `/dev/video*` 沒出 | sensor driver 找不到對應 camera | 確認 driver .deb 是 **L4T 36.5** 不是 36.4，且包含 LI-MAX96712 字樣 |

---

## 8. 變更硬體後的處理

GMSL2 不是 USB，**不可熱插拔**。任何拔插 / 換相機後必須：

```bash
sudo systemctl restart zed_x_daemon
# 或
sudo reboot
```

---

## 9. 升級或重灌 driver

```bash
# 卸載舊版
sudo dpkg -l | grep stereolabs
sudo dpkg -r stereolabs-zedlink-duo   # 名字以實際 dpkg -l 為準

# 裝新版
sudo dpkg -i ~/stereolabs-zedlink-duo_<新版本>.deb
sudo reboot
```

---

## 10. 完整一鍵安裝腳本

`install-orin-zedx.sh`（含全部步驟，僅需準備 `~/ZED_SDK.run` 與 `~/stereolabs-zedlink-duo.deb` 兩個檔案）：

```bash
#!/bin/bash
set -uo pipefail
read -rsp "mirdc password: " PASS </dev/tty; echo

echo "$PASS" | sudo -S apt update
echo "$PASS" | sudo -S apt install -y nvidia-jetpack libqt5core5a curl wget v4l-utils zstd expect

# ZED SDK install via expect
cat > /tmp/zed_install.exp <<EOF
#!/usr/bin/expect -f
set timeout 1800
log_user 1
set env(PAGER) "cat"
set env(DEBIAN_FRONTEND) "noninteractive"
set sudo_pass "${PASS}"
spawn /home/mirdc/ZED_SDK.run
expect {
  -re {password for mirdc|\[sudo\] password} { send "\$sudo_pass\r"; exp_continue }
  -re {EULA|license.*accept|Do you accept} { send "Y\r"; exp_continue }
  -re {press q|---more---|\(END\)} { send "q"; exp_continue }
  -re {press.*Enter|to continue} { send "\r"; exp_continue }
  -re {Optimize.*AI|Skip the AI} { send "n\r"; exp_continue }
  -re {Python|Sample|Install.*Driver|ZED-X} { send "Y\r"; exp_continue }
  -re {Static or Dynamic|static} { send "1\r"; exp_continue }
  -re {\(Y/n\)|\[Y/n\]} { send "Y\r"; exp_continue }
  -re {\(y/N\)|\[y/N\]} { send "n\r"; exp_continue }
  eof { puts "\nINSTALLER_DONE" }
}
EOF
chmod 600 /tmp/zed_install.exp
/usr/bin/expect /tmp/zed_install.exp
shred -u /tmp/zed_install.exp 2>/dev/null || rm -f /tmp/zed_install.exp

# Driver install
echo "$PASS" | sudo -S dpkg -i ~/stereolabs-zedlink-duo.deb
echo "$PASS" | sudo -S apt install -f -y
echo "$PASS" | sudo -S systemctl daemon-reload
echo "$PASS" | sudo -S systemctl restart zed_x_daemon

unset PASS
echo ""
echo "🎉 Done. Reboot now: sudo reboot"
echo "After reboot: ls /dev/video* && sudo dmesg | grep zedx"
```

跑：
```bash
chmod +x install-orin-zedx.sh
bash install-orin-zedx.sh
sudo reboot
```

重啟後驗證 `ls /dev/video*` 出現 `/dev/video0` `/dev/video1` 即完成。

---

## 11. 參考連結

- ZED SDK 下載：[https://www.stereolabs.com/developers/release](https://www.stereolabs.com/developers/release)
- ZED Link driver 下載：[https://www.stereolabs.com/developers/drivers](https://www.stereolabs.com/developers/drivers)
- AGX Orin DevKit + ZED Link Duo 官方 setup guide：[https://www.stereolabs.com/docs/embedded/zed-link/dual-jetson-orin-agx-devkit-setup](https://www.stereolabs.com/docs/embedded/zed-link/dual-jetson-orin-agx-devkit-setup)
- Driver install 官方 doc：[https://www.stereolabs.com/docs/embedded/zed-link/install-the-drivers/](https://www.stereolabs.com/docs/embedded/zed-link/install-the-drivers/)
- GMSL2 troubleshooting：[https://www.stereolabs.com/docs/embedded/zed-link/troubleshooting](https://www.stereolabs.com/docs/embedded/zed-link/troubleshooting)
