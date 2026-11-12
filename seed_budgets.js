const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'fusion_db',
  password: 'praveen123',
  port: 5432,
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('Creating departments table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(business_id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('Creating budgets table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS budgets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_id UUID REFERENCES departments(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        monthly_limit NUMERIC(15, 2) NOT NULL,
        valid_from DATE NOT NULL,
        valid_to DATE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get the first business_id
    const bizRes = await client.query('SELECT business_id FROM businesses LIMIT 1');
    if (bizRes.rows.length === 0) throw new Error('No businesses found to attach budgets to.');
    const businessId = bizRes.rows[0].business_id;

    console.log(`Seeding departments for business ${businessId}...`);
    const depsRes = await client.query(`
      INSERT INTO departments (business_id, name) VALUES 
      ($1, 'Engineering'),
      ($1, 'Marketing'),
      ($1, 'Operations'),
      ($1, 'Sales')
      RETURNING id, name
    `, [businessId]);

    const deps = depsRes.rows;

    console.log('Seeding budgets...');
    for (const dep of deps) {
      if (dep.name === 'Engineering') {
        await client.query(`INSERT INTO budgets (department_id, category, monthly_limit, valid_from) VALUES ($1, 'Software & Servers', 1500000, '2026-01-01')`, [dep.id]);
        await client.query(`INSERT INTO budgets (department_id, category, monthly_limit, valid_from) VALUES ($1, 'Payroll', 4000000, '2026-01-01')`, [dep.id]);
      } else if (dep.name === 'Marketing') {
        await client.query(`INSERT INTO budgets (department_id, category, monthly_limit, valid_from) VALUES ($1, 'Ad Spend', 2000000, '2026-01-01')`, [dep.id]);
        await client.query(`INSERT INTO budgets (department_id, category, monthly_limit, valid_from) VALUES ($1, 'Events', 500000, '2026-01-01')`, [dep.id]);
      } else if (dep.name === 'Operations') {
        await client.query(`INSERT INTO budgets (department_id, category, monthly_limit, valid_from) VALUES ($1, 'Office & Rent', 1000000, '2026-01-01')`, [dep.id]);
        await client.query(`INSERT INTO budgets (department_id, category, monthly_limit, valid_from) VALUES ($1, 'Logistics', 800000, '2026-01-01')`, [dep.id]);
      } else if (dep.name === 'Sales') {
        await client.query(`INSERT INTO budgets (department_id, category, monthly_limit, valid_from) VALUES ($1, 'Travel & Entertainment', 1200000, '2026-01-01')`, [dep.id]);
      }
    }

    // Now seed some simulated actuals into bank_transactions so we have variance data
    const accRes = await client.query(`SELECT account_id FROM business_bank_accounts WHERE business_id = $1 LIMIT 1`, [businessId]);
    if (accRes.rows.length > 0) {
        const accId = accRes.rows[0].account_id;
        console.log(`Seeding bank_transactions for account ${accId}...`);
        
        const insertTxn = async (amt, cat) => {
            await client.query(`
                INSERT INTO bank_transactions (account_id, business_id, txn_id, txn_date, amount, direction, narration, category, balance_after)
                VALUES ($1, $2, gen_random_uuid()::uuid, CURRENT_DATE - (random() * 30)::int, $3, 'DEBIT', 'Simulated Expense', $4, 0)
            `, [accId, businessId, amt, cat]);
        };

        // Insert actuals
        await insertTxn(1200000, 'Software & Servers'); // Under budget (15L)
        await insertTxn(4100000, 'Payroll'); // Over budget (40L)
        await insertTxn(2500000, 'Ad Spend'); // Over budget (20L)
        await insertTxn(400000, 'Events'); // Under budget (5L)
        await insertTxn(950000, 'Office & Rent'); // Under budget (10L)
        await insertTxn(700000, 'Logistics'); // Under budget (8L)
        await insertTxn(1500000, 'Travel & Entertainment'); // Over budget (12L)
    }

    await client.query('COMMIT');
    console.log('✅ Budgets seeded successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
