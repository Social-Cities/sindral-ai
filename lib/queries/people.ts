import "server-only";
import { cache } from "react";
import { callAuthed } from "@/lib/api";
import type { Human, Teammate } from "@/lib/db/types";

export const getTeammates = cache(async (): Promise<Teammate[]> => {
  const r = await callAuthed<{ teammates: Teammate[] }>("/people/teammates");
  return r.teammates;
});

export const getHumans = cache(async (): Promise<Human[]> => {
  const r = await callAuthed<{ humans: Human[] }>("/people/humans");
  return r.humans;
});
