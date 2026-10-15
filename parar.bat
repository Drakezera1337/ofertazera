@echo off
rem Para o servidor do Ofertazera (que roda sem janela)
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Host 'Ofertazera parado.' } else { Write-Host 'O Ofertazera nao estava rodando.' }"
timeout /t 3 >nul
