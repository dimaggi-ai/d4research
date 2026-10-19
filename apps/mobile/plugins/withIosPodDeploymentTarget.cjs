const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const marker = "# d4: align legacy pod resource targets with the application minimum";
const hook = "post_install do |installer|\n";
const patch = `${marker}
    installer.pods_project.targets.each do |target|
      # Xcode's .xcode.env supplies Node; login profiles can lower hard limits.
      if target.name == 'EXUpdates'
        target.shell_script_build_phases.each do |phase|
          phase.shell_script = phase.shell_script.gsub('bash -l -c', 'bash -c')
        end
      end
      target.build_configurations.each do |configuration|
        minimum = configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if minimum && Gem::Version.new(minimum) < Gem::Version.new('18.0')
          configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '18.0'
        end
      end
    end
`;

module.exports = (config) =>
  withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const file = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const contents = fs.readFileSync(file, "utf8");
      if (!contents.includes(marker)) {
        if (!contents.includes(hook)) throw new Error("Podfile post_install hook is missing");
        fs.writeFileSync(file, contents.replace(hook, hook + patch));
      }
      return nextConfig;
    },
  ]);
