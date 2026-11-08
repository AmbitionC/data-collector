#!/bin/sh
# Turns on blocker emails through the fe-journey-faas alert mailer. Run it yourself: paste the
# personal HEALTH_API_TOKEN (the X-Health-Token your shortcuts use). It is stored only in
# ~/.data-collector/notify-faas.json (mode 0600). Mail goes to the faas PAY_NOTIFY_EMAIL inbox.
set -eu
printf 'HEALTH_API_TOKEN（不会显示）: '; stty -echo; read -r token; stty echo; echo
umask 077
FILE="$HOME/.data-collector/notify-faas.json"
TOKEN="$token" /usr/bin/python3 -c 'import json,os;print(json.dumps({"token":os.environ["TOKEN"]}))' > "$FILE"
chmod 600 "$FILE"
"$HOME/.nvm/versions/node/v22.22.3/bin/node" --input-type=module -e "import { sendFaasAlert } from '$HOME/code/data-collector/packages/bridge/dist/autopilot/core.js'; console.log('测试邮件：', await sendFaasAlert('$HOME/.data-collector', '牛客运营邮件提醒已开通', '以后遇到验证码、风控、授权这类需要你处理的阻塞，会发到这个邮箱。'));"
