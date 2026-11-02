import { makeSecretProviderDefinitionRegistry } from "@d4research/secret-provider-core/shared/definition";
import * as OnePassword from "@d4research/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
