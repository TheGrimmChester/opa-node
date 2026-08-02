# opa-node IAST-lite (Wave 19)

Detection only — never blocks requests.

```js
const opa = require('opa-node');
opa.start({ service: 'api' });

// From your SQL wrapper:
opa.iast.checkSQL("SELECT * FROM t WHERE id=' + req.query.id");

// Optional: wrap child_process.exec / execSync
opa.iast.installHooks();
```

Findings are `type:iast` ND-JSON lines. Pair with Agent Wave 19 + Dashboard `/security`.
