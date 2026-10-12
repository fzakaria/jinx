let
  base = { a = 1; b = { c = 2; d = 3; }; };
  r = rec { x = 1; y = x + 1; z = y * 2; };
  inh = let p = 5; q = 6; in { inherit p q; inherit (base) a; inherit (base.b) c; };
  dyn = let k = "dyn"; in { ${k} = 1; "${k}2" = 2; ${null} = 3; };
in
{
  sel = base.b.c;
  selOr = base.b.missing or "fallback";
  selOrDeep = base.a.b.c or 7;
  has = [ (base ? a) (base ? b.c) (base ? b.x) (base ? z.y) ];
  inherit r inh dyn;
  upd = base // { a = 9; e = 10; };
  updRec = (r // { x = 100; }).y;
  names = builtins.attrNames { b = 1; a = 2; "1" = 3; "10" = 4; "2" = 5; A = 6; _ = 7; };
  values = builtins.attrValues { b = 1; a = 2; };
  merged = { a.b = 1; a.c = 2; a = { d = 3; }; };
  mapped = builtins.mapAttrs (k: v: "${k}=${toString v}") { x = 1; y = 2; };
  listToAttrs = builtins.listToAttrs [ { name = "a"; value = 1; } { name = "a"; value = 2; } { name = "b"; value = 3; } ];
  intersect = builtins.intersectAttrs { a = 1; b = 2; } { b = 3; c = 4; };
  removed = removeAttrs { a = 1; b = 2; c = 3; } [ "a" "c" ];
  cat = builtins.catAttrs "x" [ { x = 1; } { y = 2; } { x = 3; } ];
  zip = builtins.zipAttrsWith (n: vs: vs) [ { a = 1; } { a = 2; b = 3; } ];
  eq = [ ({ a = 1; } == { a = 1; }) ({ a = 1; } == { a = 2; }) ([ 1 2 ] == [ 1 2 ]) (1 == 1.0) ("a" == "a") ((x: x) == (x: x)) ];
  withTest = with base; [ a b.c ];
  withShadow = let a = 0; in with { a = 1; }; a;
  withNested = with { a = 1; }; with { a = 2; b = 3; }; [ a b ];
  fargs = builtins.functionArgs ({ a, b ? 1, ... }: a);
  fargs2 = builtins.functionArgs (x: x);
  groupBy = builtins.groupBy (x: if x < 3 then "small" else "big") [ 1 2 3 4 ];
  deep = builtins.deepSeq { a = 1; } "ok";
  toJSON = builtins.toJSON { b = 1; a = [ 1 2.5 "x" null true ]; "1" = { }; };
  fromJSON = builtins.fromJSON ''{"a": [1, 2.0, "x", null, true], "b": {"c": "d"}}'';
}
