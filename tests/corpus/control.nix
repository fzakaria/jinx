let
  f = x: y: x + y;
  g = { a, b ? a + 1, ... }@args: [ a b (builtins.attrNames args) ];
  fact = n: if n <= 1 then 1 else n * fact (n - 1);
  fix = f: let x = f x; in x;
  pkgs = fix (self: { a = 1; b = self.a + 1; c = self.b + 1; });
  functor = { __functor = self: x: x + self.n; n = 10; };
in
{
  curried = f 1 2;
  partial = let add1 = f 1; in add1 41;
  formals = g { a = 1; extra = true; };
  formalsDefault = g { a = 5; b = 0; };
  fact5 = fact 5;
  fixpoint = pkgs.c;
  functorCall = functor 5;
  ifThen = if 1 < 2 then "yes" else "no";
  assertOk = assert 1 == 1; "passed";
  tryThrow = builtins.tryEval (throw "boom");
  tryOk = builtins.tryEval 42;
  tryAssert = builtins.tryEval (assert false; 1);
  lazyArg = (x: 1) (throw "never");
  lazyAttr = { a = throw "never"; b = 2; }.b;
  implies = [ (true -> false) (false -> false) ];
  logic = [ (true && false) (true || false) (!true) ];
  seq = builtins.seq 1 2;
  let1 = let a = 1; b = a + 1; in a + b;
  letRec = let even = n: n == 0 || odd (n - 1); odd = n: n != 0 && even (n - 1); in even 10;
  letShadow = let x = 1; in let y = x + 1; in let x = y; in x;
  typeOf = map builtins.typeOf [ 1 1.0 "s" true null [ ] { } (x: x) ];
  isX = [ (builtins.isInt 1) (builtins.isFloat 1) (builtins.isString "") (builtins.isList [ ]) (builtins.isAttrs { }) (builtins.isFunction (x: x)) (isNull null) (builtins.isBool false) ];
  pipe = let inherit (builtins) map; in map (x: x + 1) [ 1 ];
  ints = [ 9223372036854775807 (-9223372036854775807 - 1) (builtins.bitAnd 12 10) (builtins.bitOr 12 10) (builtins.bitXor 12 10) ];
  floats = [ (builtins.floor 2.7) (builtins.ceil 2.1) (1 / 2.0) 1.0e10 ];
  trace = builtins.trace "tracing" 1;
  addErr = builtins.tryEval (builtins.addErrorContext "ctx" (throw "x"));
}
