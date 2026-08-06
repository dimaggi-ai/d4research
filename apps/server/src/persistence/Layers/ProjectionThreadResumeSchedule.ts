import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ListDueProjectionThreadResumeScheduleInput,
  ProjectionThreadResumeSchedule,
  ProjectionThreadResumeScheduleRepository,
  ProjectionThreadResumeScheduleThreadInput,
  type ProjectionThreadResumeScheduleRepositoryShape,
} from "../Services/ProjectionThreadResumeSchedule.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadResumeSchedule,
    execute: (row) => sql`
      INSERT INTO projection_thread_resume_schedule (
        thread_id,
        resume_at,
        reason,
        provider,
        instance_id,
        model,
        prompt,
        created_at,
        attempts
      )
      VALUES (
        ${row.threadId},
        ${row.resumeAt},
        ${row.reason},
        ${row.provider},
        ${row.instanceId},
        ${row.model},
        ${row.prompt},
        ${row.createdAt},
        ${row.attempts}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        resume_at = excluded.resume_at,
        reason = excluded.reason,
        provider = excluded.provider,
        instance_id = excluded.instance_id,
        model = excluded.model,
        prompt = excluded.prompt,
        created_at = excluded.created_at,
        attempts = excluded.attempts
    `,
  });

  const listDueRows = SqlSchema.findAll({
    Request: ListDueProjectionThreadResumeScheduleInput,
    Result: ProjectionThreadResumeSchedule,
    execute: ({ now }) => sql`
      SELECT
        thread_id AS "threadId",
        resume_at AS "resumeAt",
        reason,
        provider,
        instance_id AS "instanceId",
        model,
        prompt,
        created_at AS "createdAt",
        attempts
      FROM projection_thread_resume_schedule
      WHERE resume_at <= ${now}
      ORDER BY resume_at ASC, created_at ASC, thread_id ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: ProjectionThreadResumeScheduleThreadInput,
    Result: ProjectionThreadResumeSchedule,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        resume_at AS "resumeAt",
        reason,
        provider,
        instance_id AS "instanceId",
        model,
        prompt,
        created_at AS "createdAt",
        attempts
      FROM projection_thread_resume_schedule
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: ProjectionThreadResumeScheduleThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_resume_schedule
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadResumeScheduleRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadResumeScheduleRepository.upsert:query"),
      ),
    );
  const listDue: ProjectionThreadResumeScheduleRepositoryShape["listDue"] = (input) =>
    listDueRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadResumeScheduleRepository.listDue:query"),
      ),
    );
  const getByThreadId: ProjectionThreadResumeScheduleRepositoryShape["getByThreadId"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadResumeScheduleRepository.getByThreadId:query"),
      ),
    );
  const deleteByThreadId: ProjectionThreadResumeScheduleRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadResumeScheduleRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listDue,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadResumeScheduleRepositoryShape;
});

export const ProjectionThreadResumeScheduleRepositoryLive = Layer.effect(
  ProjectionThreadResumeScheduleRepository,
  make,
);
