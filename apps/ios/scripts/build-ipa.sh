#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
xcodegen generate
xcodebuild -project Sickrat.xcodeproj -scheme Sickrat -configuration Release -sdk iphoneos -derivedDataPath build-device CODE_SIGNING_ALLOWED=NO build
mkdir -p build/package/Payload
# Restrict cleanup to this generated package, never a user-installed app.
rm -rf build/package/Payload/Sickrat.app
cp -R build-device/Build/Products/Release-iphoneos/Sickrat.app build/package/Payload/Sickrat.app
app_info="build-device/Build/Products/Release-iphoneos/Sickrat.app/Info.plist"
app_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_info")
app_build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app_info")
ipa_name="Sickrat-${app_version}-${app_build}.ipa"
(cd build/package && /usr/bin/ditto -c -k --keepParent Payload "../${ipa_name}")
/usr/bin/unzip -t "build/${ipa_name}"
