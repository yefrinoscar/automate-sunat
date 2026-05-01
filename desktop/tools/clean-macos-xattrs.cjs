const { execFileSync } = require("node:child_process");

module.exports = async function cleanMacosXattrs(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  execFileSync("xattr", ["-cr", context.appOutDir], { stdio: "inherit" });
};
