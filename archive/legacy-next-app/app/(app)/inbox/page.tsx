import { InboxView } from "@/components/inbox-view";
import { getActivityWithTaskMap } from "@/lib/queries/activity";

export default async function InboxPage() {
  const { items, taskProjectMap } = await getActivityWithTaskMap();
  return <InboxView activity={items} taskProjectMap={taskProjectMap} />;
}
