"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Human, Teammate } from "@/lib/data";

interface PeopleValue {
  teammates: Teammate[];
  humans: Human[];
  byId: Map<string, Teammate | Human>;
  currentUserId: string;
}

const PeopleContext = createContext<PeopleValue | null>(null);

export function PeopleProvider({
  teammates,
  humans,
  currentUserId,
  children,
}: {
  teammates: Teammate[];
  humans: Human[];
  currentUserId: string;
  children: ReactNode;
}) {
  const value = useMemo<PeopleValue>(() => {
    const byId = new Map<string, Teammate | Human>();
    for (const t of teammates) byId.set(t.id, t);
    for (const h of humans) byId.set(h.id, h);
    return { teammates, humans, byId, currentUserId };
  }, [teammates, humans, currentUserId]);
  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}

function usePeople(): PeopleValue {
  const v = useContext(PeopleContext);
  if (!v) throw new Error("usePeople must be used inside <PeopleProvider>");
  return v;
}

export function useTeammates(): Teammate[] {
  return usePeople().teammates;
}

export function useHumans(): Human[] {
  return usePeople().humans;
}

export function useCurrentUserId(): string {
  return usePeople().currentUserId;
}

export function useTeammate(id: string | null | undefined): Teammate | undefined {
  const { byId } = usePeople();
  if (!id) return undefined;
  const entity = byId.get(id);
  return entity && "role" in entity ? (entity as Teammate) : undefined;
}

export function useHuman(id: string | null | undefined): Human | undefined {
  const { byId } = usePeople();
  if (!id) return undefined;
  const entity = byId.get(id);
  return entity && !("role" in entity) ? (entity as Human) : undefined;
}

export function usePerson(id: string | null | undefined): Teammate | Human | undefined {
  const { byId } = usePeople();
  if (!id) return undefined;
  return byId.get(id);
}
