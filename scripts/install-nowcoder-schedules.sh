#!/bin/sh
# Installs the article and interview-collection schedules. Run it yourself; each is an
# independent launchd job. Comments already have their own job.
set -eu
NODE="$HOME/.nvm/versions/node/v22.22.3/bin/node"
REPO="$HOME/code/data-collector"
DIR="$HOME/.data-collector/nowcoder-autopilot"
write() { # label, program arguments, schedule
  plist="$HOME/Library/LaunchAgents/com.data-collector.$1.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.data-collector.$1</string>
<key>ProgramArguments</key><array><string>$NODE</string>$2</array>
<key>WorkingDirectory</key><string>$REPO</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
$3
<key>StandardOutPath</key><string>$DIR/$1.out.log</string>
<key>StandardErrorPath</key><string>$DIR/$1.err.log</string>
</dict></plist>
EOF
  plutil -lint "$plist"
  launchctl bootout "gui/$(id -u)/com.data-collector.$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
}
write nowcoder-articles "<string>$REPO/packages/bridge/dist/cli.js</string><string>nowcoder</string><string>articles</string><string>autopilot</string><string>--send</string>" '<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>'
hours=''; for h in 0 3 6 9 15 21; do hours="$hours<dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>0</integer></dict>"; done
write nowcoder-collection "<string>$REPO/scripts/nowcoder-collection-run.mjs</string>" "<key>StartCalendarInterval</key><array>$hours</array>"
launchctl list | grep com.data-collector
