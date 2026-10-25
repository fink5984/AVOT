import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="טוען" className="px-4 pt-5 lg:px-8 lg:pt-7">
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="mt-3 h-7 w-80" />
      <Skeleton className="mt-3 h-4 w-56" />
      <div className="card mt-8 space-y-3 p-5">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  );
}
