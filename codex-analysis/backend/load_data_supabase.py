#!/usr/bin/env python3
"""
Data Loader for Codex Analysis Platform - SUPABASE VERSION
Populates Supabase PostgreSQL database with pre-computed analysis data

Usage:
    python load_data_supabase.py \
        --database-url postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres \
        --data-file codex_analysis_data.json

Get your connection string from Supabase:
  1. Go to Project Settings → Database
  2. Copy the "Connection string" (PostgreSQL)
  3. Replace [PASSWORD] with your actual password
  4. Use it as --database-url

Example:
    python load_data_supabase.py \
        --database-url "postgresql://postgres:your_password@db.xyzabc.supabase.co:5432/postgres" \
        --data-file codex_analysis_data.json
"""

import json
import sys
import argparse
from datetime import datetime
from pathlib import Path
import asyncpg

class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'

def print_header(msg):
    print(f"\n{Colors.HEADER}{Colors.BOLD}{msg}{Colors.ENDC}")

def print_success(msg):
    print(f"{Colors.OKGREEN}✓ {msg}{Colors.ENDC}")

def print_error(msg):
    print(f"{Colors.FAIL}✗ {msg}{Colors.ENDC}")

def print_info(msg):
    print(f"{Colors.OKCYAN}ℹ {msg}{Colors.ENDC}")

async def create_tables(conn):
    """Create necessary database tables on Supabase"""

    print_header("Creating Database Tables on Supabase")

    # Enable UUID extension
    try:
        await conn.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
        print_success("Enabled UUID extension")
    except:
        print_info("UUID extension already enabled")

    # Table 1: Issues
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS issues (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            source VARCHAR(50),
            source_id VARCHAR(500) UNIQUE,
            product VARCHAR(50),
            title TEXT,
            description TEXT,
            url TEXT,
            sentiment_score NUMERIC(3,2),
            engagement_score NUMERIC(8,2),
            mention_count INTEGER DEFAULT 1,
            category VARCHAR(100),
            severity VARCHAR(20),
            root_cause_id UUID,
            duplicate_of_id UUID,
            tags TEXT[],
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
    ''')
    print_success("Created 'issues' table")

    # Table 2: Issue TimeSeries
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS issue_timeseries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            issue_id UUID REFERENCES issues(id) ON DELETE CASCADE,
            date DATE,
            mention_count INTEGER,
            sentiment_average NUMERIC(3,2),
            sentiment_std NUMERIC(3,2),
            engagement_average NUMERIC(8,2),
            new_comments INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
        )
    ''')
    print_success("Created 'issue_timeseries' table")

    # Table 3: Root Causes
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS root_causes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            product VARCHAR(50),
            title VARCHAR(500),
            description TEXT,
            component VARCHAR(200),
            error_type VARCHAR(100),
            severity VARCHAR(20),
            first_detected DATE,
            identified_date DATE,
            fixed_date DATE,
            fixed_in_version VARCHAR(50),
            estimated_users_impacted_percentage NUMERIC(5,2),
            affected_issue_count INTEGER,
            notes TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    ''')
    print_success("Created 'root_causes' table")

    # Table 4: User Segments
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS user_segments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(100) UNIQUE,
            developer_count_range VARCHAR(50),
            crisis_severity NUMERIC(5,2),
            cost_impact NUMERIC(5,2),
            recovery_speed NUMERIC(5,2),
            description TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    ''')
    print_success("Created 'user_segments' table")

    # Table 5: Issue Categories
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS issue_categories (
            id INTEGER PRIMARY KEY,
            name VARCHAR(200),
            count INTEGER,
            percentage NUMERIC(5,2),
            severity_avg VARCHAR(50),
            description TEXT
        )
    ''')
    print_success("Created 'issue_categories' table")

    # Table 6: Competitive Data
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS competitive_data (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            product VARCHAR(100),
            code_quality_score NUMERIC(5,2),
            efficiency_score NUMERIC(5,2),
            cost_per_task NUMERIC(10,2),
            context_window_tokens INTEGER,
            agent_autonomy_score NUMERIC(5,2),
            uptime_sla NUMERIC(5,2),
            strengths TEXT[],
            weaknesses TEXT[],
            created_at TIMESTAMP DEFAULT NOW()
        )
    ''')
    print_success("Created 'competitive_data' table")

    # Create indices for faster queries
    print_info("Creating indices...")
    try:
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_issues_product ON issues(product)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_issues_category ON issues(category)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_issues_sentiment ON issues(sentiment_score)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_root_cause_product ON root_causes(product)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_timeseries_issue ON issue_timeseries(issue_id, date)')
        print_success("Created all indices")
    except Exception as e:
        print_info(f"Index creation note: {str(e)[:100]}")

async def load_issue_categories(conn, data):
    """Load issue category reference data"""
    print_header("Loading Issue Categories")

    for category in data['issue_categories']:
        try:
            await conn.execute('''
                INSERT INTO issue_categories
                (id, name, count, percentage, severity_avg, description)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO UPDATE SET
                    name = $2, count = $3, percentage = $4, severity_avg = $5, description = $6
            ''',
            category['id'], category['name'], category['count'],
            category['percentage'], category['severity_avg'], category['description']
            )
        except Exception as e:
            print_error(f"Error loading category {category['id']}: {e}")

    print_success(f"Loaded {len(data['issue_categories'])} issue categories")

async def load_user_segments(conn, data):
    """Load user segment reference data"""
    print_header("Loading User Segments")

    for segment in data['user_segments']:
        try:
            await conn.execute('''
                INSERT INTO user_segments
                (name, developer_count_range, crisis_severity, cost_impact, recovery_speed, description)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (name) DO UPDATE SET
                    developer_count_range = $2, crisis_severity = $3,
                    cost_impact = $4, recovery_speed = $5, description = $6
            ''',
            segment['name'], segment['developer_count_range'],
            segment['crisis_severity'], segment['cost_impact'],
            segment['recovery_speed'], segment['description']
            )
        except Exception as e:
            print_error(f"Error loading segment {segment['name']}: {e}")

    print_success(f"Loaded {len(data['user_segments'])} user segments")

async def load_root_causes(conn, data):
    """Load root cause analysis data"""
    print_header("Loading Root Causes")

    count = 0
    for rc in data.get('root_causes', []):
        try:
            await conn.execute('''
                INSERT INTO root_causes
                (product, title, description, component, error_type, severity,
                 first_detected, identified_date, fixed_date, fixed_in_version,
                 estimated_users_impacted_percentage, affected_issue_count, notes)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ''',
            rc['product'], rc['title'], rc['description'], rc['component'],
            rc['error_type'], rc['severity'], rc['first_detected'],
            rc['identified_date'], rc['fixed_date'], rc['fixed_in_version'],
            rc['affected_users_percentage'], rc['affected_issue_count'],
            rc.get('notes', '')
            )
            count += 1
        except Exception as e:
            print_error(f"Error loading root cause {rc.get('title', 'unknown')}: {e}")

    print_success(f"Loaded {count} root causes")

async def load_competitive_data(conn, data):
    """Load competitive analysis data"""
    print_header("Loading Competitive Analysis")

    count = 0
    for comp in data.get('competitive_analysis', []):
        try:
            await conn.execute('''
                INSERT INTO competitive_data
                (product, code_quality_score, efficiency_score, cost_per_task,
                 context_window_tokens, agent_autonomy_score, uptime_sla, strengths, weaknesses)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ''',
            comp['product'], comp['code_quality_score'], comp['efficiency_score'],
            comp['cost_per_task'], comp['context_window_tokens'],
            comp['agent_autonomy_score'], comp['uptime_sla'],
            comp['strengths'], comp['weaknesses']
            )
            count += 1
        except Exception as e:
            print_error(f"Error loading product {comp.get('product', 'unknown')}: {e}")

    print_success(f"Loaded {count} competitive products")

async def load_timeline_data(conn, data):
    """Load timeline sentiment data as synthetic issues"""
    print_header("Loading Timeline Data")

    count = 0
    for month_data in data.get('timeline_data', []):
        try:
            month = month_data['month']
            await conn.execute('''
                INSERT INTO issues
                (source, source_id, product, title, description, sentiment_score,
                 engagement_score, mention_count, category, severity, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ''',
            'internal', f'timeline_{month}', 'codex',
            f"Monthly Sentiment Summary - {month}",
            f"Aggregated sentiment data for {month}: {month_data['status']}",
            (month_data['sentiment'] / 100) * 2 - 1,
            month_data['issue_freq'] * 10,
            month_data['issue_freq'],
            'Sentiment Tracking',
            'medium',
            datetime.strptime(f"{month} 01", "%b %Y %d")
            )
            count += 1
        except Exception as e:
            print_error(f"Error loading timeline {month_data.get('month', 'unknown')}: {e}")

    print_success(f"Loaded {count} timeline months")

async def main():
    parser = argparse.ArgumentParser(
        description='Load Codex Analysis data into Supabase PostgreSQL'
    )
    parser.add_argument(
        '--database-url',
        required=True,
        help='Supabase PostgreSQL connection string'
    )
    parser.add_argument(
        '--data-file',
        default='codex_analysis_data.json',
        help='Path to JSON data file'
    )

    args = parser.parse_args()

    print_header("Codex Analysis Platform - Supabase Data Loader")

    data_path = Path(args.data_file)
    if not data_path.exists():
        print_error(f"Data file not found: {args.data_file}")
        sys.exit(1)

    print_info(f"Loading data from: {args.data_file}")
    with open(data_path) as f:
        data = json.load(f)

    print_info(f"Project: {data['project_metadata']['name']}")
    print_info(f"Data period: {data['project_metadata']['data_period']}")

    # Connect to Supabase
    print_header("Connecting to Supabase")
    try:
        conn = await asyncpg.connect(args.database_url)
        print_success("Connected to Supabase PostgreSQL")
    except Exception as e:
        print_error(f"Failed to connect: {e}")
        print_info("Make sure your connection string is correct:")
        print_info("  postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres")
        sys.exit(1)

    try:
        # Create tables
        await create_tables(conn)

        # Load data
        await load_issue_categories(conn, data)
        await load_user_segments(conn, data)
        await load_root_causes(conn, data)
        await load_competitive_data(conn, data)
        await load_timeline_data(conn, data)

        # Verify data
        print_header("Verifying Loaded Data")

        issues_count = await conn.fetchval('SELECT COUNT(*) FROM issues')
        print_info(f"Issues in database: {issues_count}")

        root_causes_count = await conn.fetchval('SELECT COUNT(*) FROM root_causes')
        print_info(f"Root causes in database: {root_causes_count}")

        segments_count = await conn.fetchval('SELECT COUNT(*) FROM user_segments')
        print_info(f"User segments in database: {segments_count}")

        print_header("Data Load Complete!")
        print_success("All data loaded to Supabase successfully")
        print_info("Next: Start building with Claude Code")

    except Exception as e:
        print_error(f"Error during data load: {e}")
        import traceback
        traceback.print_exc()
    finally:
        await conn.close()

if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
