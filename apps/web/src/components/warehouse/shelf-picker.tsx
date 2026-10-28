"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui/field";
import { api } from "@/lib/api";

interface Tree {
  id: string;
  name: string;
  zones: { id: string; name: string; shelves: { id: string; code: string; locations: { id: string; code: string; active: boolean }[] }[] }[];
}
const num = (c: string) => (/^\d+$/.test(c) ? String(Number(c)) : c);

/** warehouse → column → shelf as three small selects; reports the chosen location (or null). No codes typed. */
export function ShelfPicker({ onChange, className, excludeShelfIds }: { onChange: (loc: { id: string; code: string; label: string } | null) => void; className?: string; excludeShelfIds?: Set<string> }) {
  const [tree, setTree] = useState<Tree[]>([]);
  const [wh, setWh] = useState("");
  const [zone, setZone] = useState("");
  const [shelf, setShelf] = useState("");

  useEffect(() => {
    api<{ warehouses: Tree[] }>("/api/warehouse")
      .then((r) => {
        setTree(r.warehouses);
        setWh(r.warehouses[0]?.id ?? "");
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => setZone(""), [wh]);
  useEffect(() => setShelf(""), [zone]);

  const w = tree.find((x) => x.id === wh);
  const z = w?.zones.find((x) => x.id === zone);
  const s = z?.shelves.find((x) => x.id === shelf);
  const chosen = s && !excludeShelfIds?.has(s.id) ? s.locations.find((l) => l.active) : undefined;

  useEffect(() => {
    onChange(chosen && w && z && s ? { id: chosen.id, code: chosen.code, label: [w.name, z.name, `מדף ${num(s.code)}`].join(" · ") } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.id]);

  return (
    <div className={className ?? "flex flex-wrap gap-2"}>
      {tree.length > 1 && (
        <Select value={wh} onChange={(e) => setWh(e.target.value)} aria-label="מחסן" className="w-auto">
          {tree.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      )}
      <Select value={zone} onChange={(e) => setZone(e.target.value)} aria-label="עמודה" className="w-auto">
        <option value="">עמודה…</option>
        {w?.zones.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </Select>
      <Select value={shelf} onChange={(e) => setShelf(e.target.value)} aria-label="מדף" disabled={!z} className="w-auto">
        <option value="">מדף…</option>
        {z?.shelves.map((x) => (
          <option key={x.id} value={x.id} disabled={!x.locations.some((l) => l.active) || !!excludeShelfIds?.has(x.id)}>
            מדף {num(x.code)}
          </option>
        ))}
      </Select>
    </div>
  );
}
