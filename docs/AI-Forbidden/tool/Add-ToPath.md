function Add-ToPath {
    param (
        [Parameter(Mandatory = $true)]
        [string]$NewPath,

        # 作用域: User（当前用户）| Machine（系统级，需管理员权限）
        [ValidateSet("User", "Machine")]
        [string]$Scope = "User"
    )

    # 获取当前 Path
    $currentPath = [Environment]::GetEnvironmentVariable("Path", $Scope)
    $pathList    = $currentPath -split ";" | Where-Object { $_ -ne "" }

    Write-Host "`n📋 作用域: $Scope" -ForegroundColor Cyan
    Write-Host "📂 目标路径: $NewPath"

    # ① 检查是否已存在（忽略末尾斜杠差异）
    $exists = $pathList | Where-Object {
        $_.TrimEnd("\") -eq $NewPath.TrimEnd("\")
    }

    if ($exists) {
        Write-Host "⚠️  [已存在] 路径已在 Path 中，跳过添加。`n" -ForegroundColor Yellow
        return
    }

    Write-Host "🔍 [不存在] 当前 Path 中未找到该路径。" -ForegroundColor Gray

    # ② 检查路径是否真实存在于磁盘（可选警告）
    if (-not (Test-Path $NewPath)) {
        Write-Warning "目录在磁盘上不存在，但仍将继续添加到 Path。"
    }

    # ③ 执行添加
    try {
        $updatedPath = ($pathList + $NewPath) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $updatedPath, $Scope)

        # 同步到当前 PowerShell 会话
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [Environment]::GetEnvironmentVariable("Path", "User")

        Write-Host "✅ [添加成功] 路径已写入 $Scope 环境变量！`n" -ForegroundColor Green
    } catch {
        Write-Host "❌ [添加失败] 错误信息: $_`n" -ForegroundColor Red
    }
}

# ===================== 调用示例 =====================
Add-ToPath -NewPath "C:\MyApp\bin"                        # 添加到用户变量
Add-ToPath -NewPath "C:\MyApp\bin" -Scope "Machine"       # 添加到系统变量（需管理员）
Add-ToPath -NewPath "C:\MyApp\bin"                        # 再次添加，触发"已存在"提示

整个复制到PS运行