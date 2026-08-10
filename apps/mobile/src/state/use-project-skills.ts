import { fetchEnvironmentSkillsInventory } from "@t3tools/client-runtime/state/skills";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { runtime } from "../lib/runtime";
import { projectSkillNamesFromInventory } from "../features/threads/mobileSessionSkills";
import { usePreparedConnection } from "./session";

const EMPTY_SKILL_NAMES: ReadonlyArray<string> = Object.freeze([]);
const PROJECT_SKILLS_POLL_INTERVAL_MS = 30_000;

export function useProjectSkillNames(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<string> {
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = preparedOption._tag === "Some" ? preparedOption.value : null;
  const [names, setNames] = useState<ReadonlyArray<string>>(EMPTY_SKILL_NAMES);

  useEffect(() => {
    if (!prepared || !cwd) {
      setNames(EMPTY_SKILL_NAMES);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const result = await runtime.runPromise(fetchEnvironmentSkillsInventory({ prepared, cwd }));
        if (active) setNames(projectSkillNamesFromInventory(result.skills));
      } catch {
        if (active) setNames(EMPTY_SKILL_NAMES);
      }
    };
    void load();
    const interval = setInterval(() => void load(), PROJECT_SKILLS_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [cwd, prepared]);

  return names;
}
