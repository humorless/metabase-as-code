# Prompt

The content in [`metabase/`](metabase/) was built from the request below, in a Claude Code session that used the
`metabase-as-code` skill. The request was first written in Traditional Chinese; this is a translation.

The last section, *Data*, is not part of the original request. It maps the request onto Metabase's Sample Database so
that anyone can run it. With your own data, replace it with your tables.

---

Design and build a shipment analysis dashboard in Metabase. Its core interaction is a **guided hierarchical drill-down
(a fixed drill path)**: layer by layer, **company → industry → customer → product mix**.

Plan it around the following four layers and navigation rules.

## 1. Layers and screens

| Layer | Screen | Click interaction | Parameters passed to the next layer |
| :--- | :--- | :--- | :--- |
| **1: Company** | Monthly total shipments as a line chart, plus 3 KPI number cards | Click anywhere on the chart | **No filter parameters** (every month leads to the same view) |
| **2: Industry** | One small line chart per industry, **all sharing the same Y-axis scale** | Click an industry | The **industry** |
| **3: Customer** | Line chart of the top 10 customers (all others merged into "Other"), plus a customer ranking table | **First click** on a customer: highlight that customer. **Second click** on the same customer: drill down to the next layer. Click the **🥧 icon**: drill down to the next layer directly | The **customer** (keeping the industry from the previous layer) |
| **4: Product mix** | Pie chart of this customer's product mix within this industry | Click an entry under "This customer also ships to" | Switch the industry to **another industry of the same customer**, and update the product mix to match |

## 2. Implementation and structure

1. **Dashboards and parameter passing**:
   - Split the four layers into matching dashboards / question views, and pass parameters with **click behavior**
     (layer 1 passes nothing; layer 2 passes `industry`; layer 3 passes `customer`; layer 4 can switch to another
     `industry` of the same customer).
   - Give every layer a clear breadcrumb or a way back to the previous layer, so users can retrace their path.
2. **Consistent visuals and scales**:
   - The small industry line charts on layer 2 must use the same Y-axis range, so the industries can be compared
     directly.
   - On layer 3, group customers ranked 11th and below as "Other" so the chart does not have too many lines, and show
     the complete numbers in the ranking table.
3. **Fit with what Metabase does natively**:
   - Explain which interactions (fixed drill path, parameter passing, chart and table linking) Metabase's dashboard
     filters and click behavior support directly. For finer navigation, such as "first click on a chart highlights,
     second click drills down" or "a specific button switches to another industry", propose workable alternatives or
     custom implementations within Metabase.

## Data

Use the Sample Database on the `local` profile. Read it as follows:

- a shipment is an order line (`ORDERS`); units shipped are `ORDERS.QUANTITY`, the shipment date is `ORDERS.CREATED_AT`
- the industry is the product category (`PRODUCTS.CATEGORY`: Doohickey, Gadget, Gizmo, Widget)
- the customer is the person who ordered (`PEOPLE.NAME`); a customer can appear in several industries
- the product is `PRODUCTS.TITLE`
