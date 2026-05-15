import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type { TaskJob, TaskJobEvent } from "@/lib/db/types";

export const getTaskJobs = cache(async (taskId: string): Promise<TaskJob[]> => {
  try {
    const r = await callAuthed<{ jobs: TaskJob[] }>(
      `/tasks/${encodeURIComponent(taskId)}/jobs`,
    );
    return r.jobs;
  } catch {
    return [];
  }
});

export const getJob = cache(
  async (
    jobId: string,
  ): Promise<{ job: TaskJob; events: TaskJobEvent[] } | null> => {
    try {
      const r = await callAuthed<{ job: TaskJob; events: TaskJobEvent[] }>(
        `/jobs/${encodeURIComponent(jobId)}`,
      );
      return { job: r.job, events: r.events };
    } catch {
      return null;
    }
  },
);
