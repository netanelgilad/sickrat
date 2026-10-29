#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
xcodegen generate
xcodebuild -project Sickrat.xcodeproj -scheme Sickrat -configuration Release -sdk iphoneos -derivedDataPath build-device CODE_SIGNING_ALLOWED=NO build
mkdir -p build/package/Payload
# Restrict cleanup to this generated package, never a user-installed app.
rm -rf build/package/Payload/Sickrat.app
cp -R build-device/Build/Products/Release-iphoneos/Sickrat.app build/package/Payload/Sickrat.app
(cd build/package && /usr/bin/ditto -c -k --keepParent Payload ../Sickrat-0.1.0-1.ipa)
/usr/bin/unzip -t build/Sickrat-0.1.0-1.ipa
