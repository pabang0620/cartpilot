#!/usr/bin/env bash
# End-to-end API check against a running server (MOCK mode recommended).
# Usage: BASE=http://localhost:3001 npm run smoke
set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
J='content-type: application/json'
jget() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=($1); console.log(typeof v==='string'?v:JSON.stringify(v))"; }
chat() { curl -sf -XPOST "$BASE/api/chat" -H "$J" -d "{\"sessionId\":\"$SID\",\"message\":\"$1\"}"; }

echo "1. health:   $(curl -sf "$BASE/api/health" | jget 'd.data.modes')"
SID=$(curl -sf -XPOST "$BASE/api/session" | jget 'd.data.sessionId')
echo "2. session:  $SID"

R=$(chat 'I need three camping chairs for a festival, under $300 total')
echo "3. shop:     tools=$(echo "$R" | jget 'd.data.events.map(e=>e.tool).join(",")')"
CART=$(echo "$R" | jget 'd.data.state.cart.id')
echo "   cart:     total=$(echo "$R" | jget 'd.data.state.cart.total') budget=$(echo "$R" | jget 'd.data.state.budget')"

R=$(curl -sf -XPOST "$BASE/api/checkout" -H "$J" -d "{\"sessionId\":\"$SID\",\"cartId\":\"$CART\"}")
OID=$(echo "$R" | jget 'd.data.orderId')
echo "4. checkout: order=$OID approveUrl=$(echo "$R" | jget 'd.data.approveUrl')"

LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -XPOST "$BASE/mock-paypal/approve" -d "token=$OID")
echo "5. approve:  redirect -> ${LOC%%\?*}"
FINAL=$(curl -s -o /dev/null -w '%{redirect_url}' "$LOC")
echo "6. hold:     redirect -> $FINAL"

S=$(curl -sf "$BASE/api/state?sessionId=$SID")
echo "   order:    status=$(echo "$S" | jget 'd.data.orders[0].status') money=$(echo "$S" | jget 'd.data.orders[0].money')"

curl -sf -XPOST "$BASE/api/seller/ship" -H "$J" -d "{\"sessionId\":\"$SID\",\"orderId\":\"$OID\"}" > /dev/null
for P in PKG-1 PKG-2; do
  S=$(curl -sf -XPOST "$BASE/api/seller/deliver" -H "$J" -d "{\"sessionId\":\"$SID\",\"orderId\":\"$OID\",\"packageId\":\"$P\"}")
  echo "7. deliver:  $P money=$(echo "$S" | jget 'd.data.orders[0].money')"
done
R=$(chat 'Where are my chairs?')
echo "8. track:    $(echo "$R" | jget 'd.data.reply.split("\n")[0]')"

R=$(chat 'One chair arrived with a broken leg. Refund that one.')
APP=$(echo "$R" | jget 'd.data.state.approvals.find(a=>a.status==="pending").id')
S=$(curl -sf -XPOST "$BASE/api/approvals/$APP" -H "$J" -d "{\"sessionId\":\"$SID\",\"decision\":\"approve\"}")
echo "9. refund:   refunds=$(echo "$S" | jget 'd.data.orders[0].refunds.map(r=>r.packageId+" "+r.amount)')"

R=$(chat 'The third chair never arrived.')
APP=$(echo "$R" | jget 'd.data.state.approvals.find(a=>a.status==="pending").id')
S=$(curl -sf -XPOST "$BASE/api/approvals/$APP" -H "$J" -d "{\"sessionId\":\"$SID\",\"decision\":\"approve\"}")
echo "   release:  auth=$(echo "$S" | jget 'd.data.orders[0].authorizationStatus') money=$(echo "$S" | jget 'd.data.orders[0].money')"

echo "10. guards:"
echo "   over-refund: $(curl -s -XPOST "$BASE/api/chat" -H "$J" -d "{\"sessionId\":\"$SID\",\"message\":\"refund everything\"}" | jget 'd.data.reply.split("\n")[0]')"
echo "   foreign session checkout: $(curl -s -XPOST "$BASE/api/checkout" -H "$J" -d "{\"sessionId\":\"00000000-0000-4000-8000-000000000000\",\"cartId\":\"$CART\"}" | jget 'd.message')"
echo "   paid cart again: $(curl -s -XPOST "$BASE/api/checkout" -H "$J" -d "{\"sessionId\":\"$SID\",\"cartId\":\"$CART\"}" | jget 'd.message')"
echo "Activity entries: $(curl -sf "$BASE/api/state?sessionId=$SID" | jget 'd.data.activity.length')"
