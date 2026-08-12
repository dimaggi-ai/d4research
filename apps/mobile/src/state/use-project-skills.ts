import { fetchEnvironmentSkillsInventory } from "@t3tools/client-runtime/state/skills";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { runtime } from "../lib/runtime";
import { projectSkillNamesFromInventory } from "../features/threads/mobileSessionSkills";
import { usePreparedConnection } from "./session";

const EMPTY_SKILL_NAMES: ReadonlyArray<string> = Object.freeze([]);
const PROJECT_SKILLS_POLL_INTERVAL_MS = 30_000;

interface LoadedProjectSkillNames {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly names: ReadonlyArray<string>;
}

export function useProjectSkillNames(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<string> {
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = preparedOption._tag === "Some" ? preparedOption.value : null;
  const [loaded, setLoaded] = useState<LoadedProjectSkillNames | null>(null);

  useEffect(() => {
    if (!prepared || !cwd) {
      setLoaded(null);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const result = await runtime.runPromise(fetchEnvironmentSkillsInventory({ prepared, cwd }));
        if (active) {
          setLoaded({
            environmentId,
            cwd,
            names: projectSkillNamesFromInventory(result.skills),
          });
        }
      } catch {
        if (active) setLoaded({ environmentId, cwd, names: EMPTY_SKILL_NAMES });
      }
    };
    void load();
    const interval = setInterval(() => void load(), PROJECT_SKILLS_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [cwd, environmentId, prepared]);

  return loaded?.environmentId === environmentId && loaded.cwd === cwd
    ? loaded.names
    : EMPTY_SKILL_NAMES;
}
