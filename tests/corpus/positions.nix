# unsafeGetAttrPos through literals, //, layered sets and the builtins
# that derive sets; nixpkgs reads it for meta.position.
let
  a = { x = 1; y = 2; };
  b = { y = 3; z = 4; };
  m = a // b;
  big = builtins.listToAttrs (map (i: { name = "k${toString i}"; value = i; }) (builtins.genList (i: i) 300));
  layered = (big // a) // b;
  mapped = builtins.mapAttrs (n: v: v) m;
  removed = builtins.removeAttrs m [ "x" ];
  inter = builtins.intersectAttrs { y = null; q = null; } m;
  lta = builtins.listToAttrs [ { name = "p"; value = 1; } ];
  pos = n: s: let p = builtins.unsafeGetAttrPos n s; in if p == null then null else { inherit (p) line column; file = baseNameOf p.file; };
in {
  mx = pos "x" m; my = pos "y" m; mz = pos "z" m;
  lx = pos "x" layered; ly = pos "y" layered; lk = pos "k7" layered;
  mapy = pos "y" mapped; remy = pos "y" removed; intery = pos "y" inter; ltap = pos "p" lta;
  none = pos "q" m;
}
