// Nix's `builtins.sort` is not std::sort. Since Nix 2.27 it is an in-house
// stable peeksort (a natural mergesort), with insertion sort for short ranges,
// from src/libutil/include/nix/util/sort.hh. nixpkgs contains comparators that
// are not strict weak orderings (`a: b: true`, `<=`), and for those the exact
// sequence of comparisons decides the output. This file transcribes the C++
// one statement at a time so that jinx produces the same permutation.
//
// Indices stand in for iterators: a half-open range [begin, end) over `items`.

export type Less<T> = (a: T, b: T) => boolean;

// Ranges of at most this many elements are insertion-sorted. The same cut-off
// as libstdc++'s std::sort.
const INSERTION_SORT_THRESHOLD = 16;

// Merge the sorted runs [begin, middle) and [middle, end) in place through
// `buffer`. Stable: when neither side is less than the other, the left wins.
function mergeSortedRunsInPlace<T>(
  items: T[],
  begin: number,
  middle: number,
  end: number,
  buffer: T[],
  less: Less<T>,
): void {
  // Copy both runs out so that writes into `items` never clobber unread input.
  for (let k = begin; k < end; k++) {
    buffer[k - begin] = items[k] as T;
  }
  const workingMiddle = middle - begin;
  const workingEnd = end - begin;

  let output = begin;
  let left = 0;
  let right = workingMiddle;

  // Note the inversion !less(right, left): required for the merge to be stable.
  while (left !== workingMiddle && right !== workingEnd) {
    const takeLeft = !less(buffer[right] as T, buffer[left] as T);
    items[output++] = takeLeft ? (buffer[left++] as T) : (buffer[right++] as T);
  }

  // Whichever side still has elements is already in order.
  while (left !== workingMiddle) {
    items[output++] = buffer[left++] as T;
  }
  while (right !== workingEnd) {
    items[output++] = buffer[right++] as T;
  }
}

// Plain insertion sort of [begin, end), swapping each element leftwards while
// it is less than its predecessor.
function insertionsort<T>(
  items: T[],
  begin: number,
  end: number,
  less: Less<T>,
): void {
  if (begin === end) {
    return;
  }
  for (let current = begin + 1; current !== end; current++) {
    for (
      let point = current;
      point !== begin && less(items[point] as T, items[point - 1] as T);
      point--
    ) {
      const tmp = items[point] as T;
      items[point] = items[point - 1] as T;
      items[point - 1] = tmp;
    }
  }
}

// Maximal i <= end such that [begin, i) is strictly decreasing under `less`.
function strictlyDecreasingPrefix<T>(
  items: T[],
  begin: number,
  end: number,
  less: Less<T>,
): number {
  if (begin === end) {
    return begin;
  }
  while (begin + 1 !== end && less(items[begin + 1] as T, items[begin] as T)) {
    begin++;
  }
  return begin + 1;
}

// Minimal i >= begin such that [i, end) is strictly decreasing under `less`.
function strictlyDecreasingSuffix<T>(
  items: T[],
  begin: number,
  end: number,
  less: Less<T>,
): number {
  if (begin === end) {
    return end;
  }
  while (end - 1 > begin && less(items[end - 1] as T, items[end - 2] as T)) {
    end--;
  }
  return end - 1;
}

// The weakly increasing variants are the strictly decreasing ones under the
// negated comparator, exactly as the C++ uses std::not_fn.
function weaklyIncreasingPrefix<T>(
  items: T[],
  begin: number,
  end: number,
  less: Less<T>,
): number {
  return strictlyDecreasingPrefix(items, begin, end, (a, b) => !less(a, b));
}

function weaklyIncreasingSuffix<T>(
  items: T[],
  begin: number,
  end: number,
  less: Less<T>,
): number {
  return strictlyDecreasingSuffix(items, begin, end, (a, b) => !less(a, b));
}

// Reverse items[begin, end) in place.
function reverseRange<T>(items: T[], begin: number, end: number): void {
  for (let lo = begin, hi = end - 1; lo < hi; lo++, hi--) {
    const tmp = items[lo] as T;
    items[lo] = items[hi] as T;
    items[hi] = tmp;
  }
}

// Sort items[begin, end), given that [begin, leftRunEnd) and [rightRunBegin, end)
// are already sorted.
function peeksortImpl<T>(
  items: T[],
  begin: number,
  end: number,
  leftRunEnd: number,
  rightRunBegin: number,
  buffer: T[],
  less: Less<T>,
): void {
  if (leftRunEnd === end || rightRunBegin === begin) {
    return;
  }

  // Short ranges go to insertion sort.
  const length = end - begin;
  if (length <= INSERTION_SORT_THRESHOLD) {
    insertionsort(items, begin, end, less);
    return;
  }

  const middle = begin + Math.floor(length / 2);

  // The known left run already covers the middle: sort the rest and merge.
  if (middle <= leftRunEnd) {
    peeksortImpl(
      items,
      leftRunEnd,
      end,
      leftRunEnd + 1,
      rightRunBegin,
      buffer,
      less,
    );
    mergeSortedRunsInPlace(items, begin, leftRunEnd, end, buffer, less);
    return;
  }

  // Likewise for the known right run.
  if (middle >= rightRunBegin) {
    peeksortImpl(
      items,
      begin,
      rightRunBegin,
      leftRunEnd,
      rightRunBegin - 1,
      buffer,
      less,
    );
    mergeSortedRunsInPlace(items, begin, rightRunBegin, end, buffer, less);
    return;
  }

  // Find the run containing middle - 1, extending it in both directions.
  let i: number;
  let j: number;
  if (!less(items[middle] as T, items[middle - 1] as T)) {
    i = weaklyIncreasingSuffix(items, leftRunEnd, middle, less);
    j = weaklyIncreasingPrefix(items, middle - 1, rightRunBegin, less);
  } else {
    i = strictlyDecreasingSuffix(items, leftRunEnd, middle, less);
    j = strictlyDecreasingPrefix(items, middle - 1, rightRunBegin, less);
    reverseRange(items, i, j);
  }

  // The whole range is a single run.
  if (i === begin && j === end) {
    return;
  }

  // Attach the middle run to whichever side it overlaps less, then merge.
  if (middle - i < j - middle) {
    peeksortImpl(items, begin, i, leftRunEnd, i - 1, buffer, less);
    peeksortImpl(items, i, end, j, rightRunBegin, buffer, less);
    mergeSortedRunsInPlace(items, begin, i, end, buffer, less);
  } else {
    peeksortImpl(items, begin, j, leftRunEnd, i, buffer, less);
    peeksortImpl(items, j, end, j + 1, rightRunBegin, buffer, less);
    mergeSortedRunsInPlace(items, begin, j, end, buffer, less);
  }
}

// Sort `items` in place with the same sequence of comparisons as Nix.
export function peeksort<T>(items: T[], less: Less<T>): void {
  const length = items.length;

  // Trivial inputs, handled the way libc++ does.
  if (length <= 1) {
    return;
  }
  if (length === 2) {
    if (less(items[1] as T, items[0] as T)) {
      const tmp = items[0] as T;
      items[0] = items[1] as T;
      items[1] = tmp;
    }
    return;
  }

  const buffer: T[] = new Array<T>(length);
  peeksortImpl(items, 0, length, 0, length, buffer, less);
}
