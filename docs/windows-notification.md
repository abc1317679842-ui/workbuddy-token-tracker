# Windows 通知「不弹横幅」的修复

> 本文件**默认不加载**。仅当用户反馈「有提示音、通知中心里能翻到，但右下角不弹横幅了」时才 Read。
> ——这是**一次性装机设置**，装完就再也不会遇到，所以从 SKILL.md 主文档里挪出来了。

**症状**：技能本身正常（账本、日志都在更新），但通知**还有提示音、在「通知中心」（Win+N）里也能翻到**，**唯独右下角不再弹出横幅**了。

**根因**：Windows 有个「**通知建议**」机制（内部名 `SmartOptOut`）—— 系统发现你对某应用的通知**长期不点开**，就会弹一条建议问你"要不要关掉这个应用的通知"；**无论你点了确认，还是系统按习惯自动降级**，它都会在注册表里给该应用写下：

```
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AppId>
    ShowBanner     = 0            ← ★横幅被关（"不弹"的直接原因）
    LastOptOutTime = <时间戳>      ← 那次"关闭"操作的记录
```

实机证据（2026-09-26 本机）：`ShowBanner=0`、`LastOptOutTime=1790248477`、`PeriodicNotificationCount=52`；同机 `Windows.ActionCenter.SmartOptOut` 项也已存在（说明建议机制确实触发过）。

**为什么在「设置 → 系统 → 通知」里找不到这个应用**：本技能的 toast 用**自定义 AppId「WorkBuddy Token Tracker」**直接调 Windows API ——
`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('WorkBuddy Token Tracker').Show($t)`
它**不是已安装应用**，因此**不出现在设置的应用列表里**（这是刻意设计：不经过 WorkBuddy 客户端通知开关，两者互不影响）→ **只能用注册表改**。

**解决方法（普通权限，无需管理员）**：

> ⚠️ **约束（必须遵守）**：以下命令会修改用户注册表。仅当用户明确同意"帮我修通知横幅"后才执行；执行前先说明要改哪两项、改完如何回退。**禁止**把"直接改注册表"当作"没弹窗"的默认第一反应（先查 `TROUBLESHOOTING.md` 的排查速查表）。

```powershell
# ① 重新打开横幅（必做）
Set-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\WorkBuddy Token Tracker" -Name ShowBanner -Value 1

# ② 关掉"通知建议"，免得以后又被问"要不要关掉该应用通知"（可选但推荐）
$k = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.ActionCenter.SmartOptOut"
New-Item -Path $k -Force | Out-Null
New-ItemProperty -Path $k -Name Enabled -Value 0 -PropertyType DWord -Force | Out-Null
```

**验证**（回显 `ShowBanner : 1` 即已恢复）：

```powershell
Get-ItemProperty "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\WorkBuddy Token Tracker" | Select-Object ShowBanner
```

**实测结果**：2026-09-26 执行 ① 后**当场恢复**（`ShowBanner 0 → 1`，后续弹窗正常）。

**其他会让横幅消失的原因**（若上面无效，按此顺序排查）：专注助手/免打扰（含自动规则：全屏、游戏、投影时段）→ 该应用通知总开关 → 电量节能限制后台活动 → 全屏应用抑制横幅 → 系统时间/时区异常。这些都在「设置 → 系统 → 通知」里可核对；**只有"自定义 AppId"这一类（本技能）必须走上面的注册表法**。
