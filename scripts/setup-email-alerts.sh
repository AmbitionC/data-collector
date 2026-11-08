#!/bin/sh
# Saves the SMTP settings used for blocker emails. Run it yourself; the password is typed
# here and stored only in ~/.data-collector/notify-email.json (mode 0600).
set -eu
printf '收件邮箱: '; read -r to
printf '发件邮箱（Gmail 等，留空则与收件相同）: '; read -r from; [ -n "$from" ] || from="$to"
printf 'SMTP 地址（Gmail 直接回车）: '; read -r url; [ -n "$url" ] || url='smtps://smtp.gmail.com:465'
printf '应用专用密码（不会显示）: '; stty -echo; read -r password; stty echo; echo
umask 077
FILE="$HOME/.data-collector/notify-email.json"
TO="$to" FROM="$from" URL="$url" PASSWORD="$password" /usr/bin/python3 -c 'import json,os;print(json.dumps({"smtpUrl":os.environ["URL"],"user":os.environ["FROM"],"password":os.environ["PASSWORD"],"from":os.environ["FROM"],"to":os.environ["TO"]}))' > "$FILE"
chmod 600 "$FILE"
"$HOME/.nvm/versions/node/v22.22.3/bin/node" --input-type=module -e "import { sendEmail } from '$HOME/code/data-collector/packages/bridge/dist/autopilot/core.js'; console.log('测试邮件：', await sendEmail('$HOME/.data-collector', '牛客运营邮件提醒已开通', '以后遇到验证码、风控、授权这类需要你处理的阻塞，会发到这个邮箱。'));"
