const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// fork: release key signing";

// Signs every build type with the fork's key when its keystore is in the environment,
// so local adb installs and CI releases can replace each other.
const SIGNING_BLOCK = `
${MARKER}
if (System.getenv("T3CODE_ANDROID_KEYSTORE_FILE")) {
    android {
        signingConfigs {
            fork {
                storeFile file(System.getenv("T3CODE_ANDROID_KEYSTORE_FILE"))
                storePassword System.getenv("T3CODE_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("T3CODE_ANDROID_KEY_ALIAS")
                keyPassword System.getenv("T3CODE_ANDROID_KEY_PASSWORD")
            }
        }
        buildTypes {
            debug { signingConfig signingConfigs.fork }
            release { signingConfig signingConfigs.fork }
        }
    }
}
`;

module.exports = function withForkAndroidSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (!nextConfig.modResults.contents.includes(MARKER)) {
      nextConfig.modResults.contents += SIGNING_BLOCK;
    }
    return nextConfig;
  });
};
