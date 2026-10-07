import { AuthEnvironmentMaintainScope } from "@d4research/contracts";
import { useMemo } from "react";

import { AuthAccessWriteScope } from "@d4research/contracts";

import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";

import { useEnvironmentScope } from "~/state/session";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";

import { useEnvironmentQuery } from "~/state/query";

import { usePrimarySessionState } from "~/environments/primary";

import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";

import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";

import type { SettingsScopeSearch } from "./settingsScope";

import { filterAvailableSettingsSearchItems } from "./settingsSearch";

import { getThreadAutoSettlementSearchAvailability } from "./settingsSearch";

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localEnvironmentDisabled = isLocalEnvironmentDisabled();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        hasCloudPublicConfig: false,
        hasEnvironment: environments.some((environment) => environment.serverConfig !== null),
        hasProviderSettingsEnvironment: environments.some((environment) =>
          isProviderSettingsEnvironmentAvailable({
            connectionPhase: environment.connection.phase,
            hasServerConfig: environment.serverConfig !== null,
          }),
        ),
        hasMacProviderSettingsEnvironment: environments.some(
          (environment) =>
            (scopeSearch.machine === undefined ||
              environment.environmentId === scopeSearch.machine) &&
            environment.serverConfig?.environment.platform.os === "darwin" &&
            isProviderSettingsEnvironmentAvailable({
              connectionPhase: environment.connection.phase,
              hasServerConfig: true,
            }),
        ),
        canManageLocalBackend,
        isWslSettingsRowVisible: isWslSettingsRowVisible({
          state: desktopWsl.data,
          error: desktopWsl.error,
        }),
        hasThreadAutoSettlement:
          getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0,
      }),
    [canManageLocalBackend, desktopWsl.data, desktopWsl.error, environments, scopeSearch.machine],
  );
}
