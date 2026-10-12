let
  xs = [ 3 1 2 ];
in
{
  head = builtins.head xs;
  tail = builtins.tail xs;
  elemAt = builtins.elemAt xs 1;
  length = builtins.length xs;
  map = map (x: x * 2) xs;
  filter = builtins.filter (x: x > 1) xs;
  concat = xs ++ [ 4 ];
  concatLists = builtins.concatLists [ xs [ 4 5 ] [ ] ];
  concatMap = builtins.concatMap (x: [ x x ]) xs;
  elem = [ (builtins.elem 2 xs) (builtins.elem 5 xs) ];
  genList = builtins.genList (i: i * i) 5;
  foldl = builtins.foldl' (acc: x: acc + x) 0 xs;
  any = builtins.any (x: x > 2) xs;
  all = builtins.all (x: x > 2) xs;
  partition = builtins.partition (x: x > 1) xs;
  sort = builtins.sort (a: b: a < b) xs;
  sortTrue = builtins.sort (a: b: true) xs;
  sortLess = builtins.sort builtins.lessThan [ 5 3 9 1 ];
  lt = [ ([ 1 2 ] < [ 1 2 3 ]) ("a" < "b") (1 < 1.5) ];
  closure = builtins.genericClosure {
    startSet = [ { key = 1; } ];
    operator = x: if x.key < 5 then [ { key = x.key + 1; } ] else [ ];
  };
  nested = [ [ 1 [ 2 ] ] [ ] ];
  lazyElem = builtins.length [ (throw "not forced") 1 ];
}
