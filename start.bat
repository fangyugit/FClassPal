@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install
)
echo 启动桌面小部件...
npm start
pause
