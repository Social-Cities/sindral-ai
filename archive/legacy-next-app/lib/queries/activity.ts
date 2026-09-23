import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type { ActivityItem } from "@/lib/db/types";

interface ActivityResponse {
  items: ActivityItem[];
  taskProjectMap: Record<string, string>;
}

export const getActivityWithTaskMap = cache(
  async (): Promise<ActivityResponse> => {
    const r = await callAuthed<ActivityResponse>("/activity");
    return { items: r.items, taskProjectMap: r.taskProjectMap };
  },
);

export const getActivity = cache(async (): Promise<ActivityItem[]> => {
  const r = await getActivityWithTaskMap();
  return r.items;
});
