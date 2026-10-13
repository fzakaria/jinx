// The per-attribute file lists of a published tree, read by the workers
// (src/browser/nixpkgs-worker.ts, src/browser/playground-worker.ts):
// .jinx/files/common.json, the files most attributes read, fetched once
// before the first list, and .jinx/files/<shard>.json, each attribute's
// ids beyond those (tools/pack-files.ts). Ids come from the two indexes
// the worker mounted (src/browser/file-ids.ts).

import {
  COMMON_FILE,
  type IndexDir,
  SRC_PREFIX,
  TREE_PREFIX,
  fileIds,
  shardOf,
} from "./file-ids.ts";
import { type FetchResponse, prefetch } from "./shims/fs-remote.ts";

const PREFETCH_CONCURRENCY = 32;

type Shard = Record<string, readonly number[]>;
export type Progress = (done: number, total: number) => void;

export class FileLists {
  private readonly filesUrl: string;
  private readonly treeRoot: string;
  private readonly srcRoot: string;
  private readonly paths: readonly string[];
  private readonly shards = new Map<string, Promise<Shard | null>>();
  private commonFetched = false;
  private common: Promise<readonly number[]> | null = null;

  // `treeRoot` and `srcRoot` are where the two indexes are mounted.
  constructor(
    filesUrl: string,
    treeRoot: string,
    srcRoot: string,
    treeIndex: IndexDir,
    srcIndex: IndexDir,
  ) {
    this.filesUrl = filesUrl;
    this.treeRoot = treeRoot;
    this.srcRoot = srcRoot;
    this.paths = fileIds(treeIndex, srcIndex);
  }

  private pathOf(id: number): string | null {
    const p = this.paths[id];
    if (p === undefined) {
      return null;
    }
    if (p.startsWith(TREE_PREFIX)) {
      return `${this.treeRoot}/${p.slice(TREE_PREFIX.length)}`;
    }
    return `${this.srcRoot}/${p.slice(SRC_PREFIX.length)}`;
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const res = (await fetch(url)) as unknown as FetchResponse;
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  private async prefetchIds(
    ids: readonly number[],
    onProgress: Progress,
  ): Promise<void> {
    const paths: string[] = [];
    for (const id of ids) {
      const p = this.pathOf(id);
      if (p !== null) {
        paths.push(p);
      }
    }
    await prefetch(paths, PREFETCH_CONCURRENCY, onProgress);
  }

  // The common ids, read once; they are fetched with the first
  // attribute's own list, as one batch.
  private commonIds(): Promise<readonly number[]> {
    if (this.common === null) {
      this.common = this.fetchJson<number[]>(
        `${this.filesUrl}/${COMMON_FILE}`,
      ).then((ids) => ids ?? []);
    }
    return this.common;
  }

  // Fetch what evaluating `name` reads, in parallel: the common files,
  // the first time, and its own, as one batch with one progress count.
  // A dotted attribute path uses its first component. A name with no
  // list fetches nothing; the evaluation reads as it goes.
  async prefetchFor(name: string, onProgress: Progress): Promise<void> {
    const top = name.split(".")[0]!;
    const key = shardOf(top);
    let shard = this.shards.get(key);
    if (shard === undefined) {
      shard = this.fetchJson<Shard>(`${this.filesUrl}/${key}.json`);
      this.shards.set(key, shard);
    }
    const ids = (await shard)?.[top];
    if (ids === undefined) {
      return;
    }
    const common = this.commonFetched ? [] : await this.commonIds();
    this.commonFetched = true;
    await this.prefetchIds([...common, ...ids], onProgress);
  }
}
