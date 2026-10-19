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

# Swift 6.4 also ships with the iOS 27.0 SDK. Runtime availability
# alone cannot hide types absent from the SDK used to compile the app.
sdk_version, status = Open3.capture2('xcrun', '--sdk', 'iphoneos', '--show-sdk-version')
abort 'Unable to resolve the iOS SDK version' unless status.success?
has_hinge_apis = Gem::Version.new(sdk_version.strip) >= Gem::Version.new('27.1')
pods = Xcodeproj::Project.open(File.expand_path('../Pods/Pods.xcodeproj', __dir__))
controls = pods.targets.find { |target| target.name == 'T3NativeControls' }
abort 'T3NativeControls pod target is missing' unless controls
controls.build_configurations.each do |configuration|
  conditions = Array(configuration.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS']).flat_map(&:split)
  conditions |= ['$(inherited)']
  conditions.delete('T3_IOS_27_1_SDK')
  conditions << 'T3_IOS_27_1_SDK' if has_hinge_apis
  configuration.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = conditions.join(' ')
end
pods.save
