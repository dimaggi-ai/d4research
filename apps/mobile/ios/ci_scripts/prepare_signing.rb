#!/usr/bin/env ruby
require 'xcodeproj'
require 'json'
require 'open3'

project = Xcodeproj::Project.open(File.expand_path('../d4research.xcodeproj', __dir__))
build_number = ENV.fetch('CI_BUILD_NUMBER', '1')
abort 'CI_BUILD_NUMBER must be a positive integer' unless build_number.match?(/\A[1-9][0-9]*\z/)
version = ENV['D4_APP_VERSION']
unless version
  mobile_dir = File.expand_path('../..', __dir__)
  output, status = Open3.capture2('node', 'node_modules/expo/bin/cli', 'config', '--json', chdir: mobile_dir)
  abort 'Unable to resolve the Expo application version' unless status.success?
  version = JSON.parse(output).fetch('version')
end

project.targets.each do |target|
  target.build_configurations.each do |configuration|
    settings = configuration.build_settings
    settings['DEVELOPMENT_TEAM'] = ENV.fetch('T3CODE_IOS_APPLE_TEAM_ID', 'CR2PTQ345T')
    settings['CODE_SIGN_STYLE'] = 'Automatic'
    settings['CURRENT_PROJECT_VERSION'] = build_number
    settings['MARKETING_VERSION'] = version
    settings['IPHONEOS_DEPLOYMENT_TARGET'] = '18.0'
    # All embedded extensions must carry the same build number as the app.
    plist_path = settings['INFOPLIST_FILE']
    next unless plist_path
    path = File.join(project.project_dir, plist_path.delete('"'))
    plist = Xcodeproj::Plist.read_from_path(path)
    plist['CFBundleVersion'] = '$(CURRENT_PROJECT_VERSION)'
    plist['CFBundleShortVersionString'] = '$(MARKETING_VERSION)'
    Xcodeproj::Plist.write_to_path(plist, path)
  end
end
project.save
