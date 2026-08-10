# AWS Hosting Guide — Svarla

Single EC2 instance running the full stack (Postgres + Svarla server + MediaBridge) with automated recovery and backups.

**Estimated cost: ~$15–18/month**

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  AWS Region (e.g. eu-north-1)                           │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  EC2  t4g.small  (Elastic IP)                     │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Docker Compose                             │  │  │
│  │  │                                             │  │  │
│  │  │  ┌──────────┐   ┌───────────────────────┐  │  │  │
│  │  │  │ Postgres │   │ Svarla                │  │  │  │
│  │  │  │ :5432    │   │ Server + MediaBridge  │  │  │  │
│  │  │  └──────────┘   │ :3000 :10443 :5060   │  │  │  │
│  │  │       │          │ :9091                 │  │  │  │
│  │  │       ▼          └───────────────────────┘  │  │  │
│  │  │  EBS gp3 30GB                              │  │  │
│  │  │  (pgdata volume)                           │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─────────────┐   ┌──────────────────────────┐        │
│  │ Elastic IP  │   │ S3 Bucket (backups)       │        │
│  │ (static)    │   │ pg_dump + EBS snapshots   │        │
│  └─────────────┘   └──────────────────────────────┘     │
│                                                         │
│  CloudWatch Auto-Recovery Alarm                         │
└─────────────────────────────────────────────────────────┘
```

---

## Components & Cost Breakdown

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| EC2 instance | t4g.small (2 vCPU, 2 GB ARM) | ~$12.00 |
| EBS volume | 30 GB gp3 | ~$2.40 |
| Elastic IP | Attached to running instance | $0.00 |
| S3 backups | ~1 GB with lifecycle | ~$0.03 |
| EBS snapshots | 30 GB, 7 daily retained | ~$0.60 |
| CloudWatch alarm | Auto-recovery | $0.00 |
| **Total** | | **~$15** |

---

## Step-by-Step Setup

### 1. Launch the EC2 Instance

**AMI:** Amazon Linux 2023 (arm64) or Ubuntu 24.04 LTS (arm64)

**Instance type:** `t4g.small` (2 vCPU, 2 GB RAM, ARM-based Graviton)

**Storage:** 30 GB gp3 root volume (3000 IOPS baseline, sufficient for Postgres)

**Key pair:** Create or select an SSH key pair for access.

**Security group rules:**

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22 | TCP | Your IP only | SSH |
| 3000 | TCP | 0.0.0.0/0 | API + WebSocket + Web UI |
| 10443 | TCP | 0.0.0.0/0 | WebRTC (client audio) |
| 5060 | UDP + TCP | Provider IPs | SIP (telephony providers) |
| 9091 | TCP | Provider IPs | Audio WebSocket (modem/Pi) |

> Restrict ports 5060 and 9091 to your telephony provider's IP ranges if possible. Never expose port 9090 — it is internal only and bound to localhost within Docker.

### 2. Allocate and Associate an Elastic IP

```bash
# Allocate
aws ec2 allocate-address --domain vpc

# Associate (use the allocation ID and instance ID)
aws ec2 associate-address --instance-id i-xxxx --allocation-id eipalloc-xxxx
```

This gives the instance a fixed public IP that survives reboots and auto-recovery events. Use this IP as your `PUBLIC_IP` environment variable.

### 3. Install Docker

On Amazon Linux 2023:

```bash
sudo dnf update -y
sudo dnf install -y docker
sudo systemctl enable docker --now
sudo usermod -aG docker ec2-user

# Install docker compose plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

Log out and back in for the group change to take effect.

### 4. Deploy Svarla

```bash
mkdir -p ~/svarla && cd ~/svarla

# Copy the production compose file and env
# (from the docker/ directory in the repo)
```

Create `docker-compose.yml` — use the production compose from `docker/docker-compose.yml` in the repo.

Create `.env`:

```bash
POSTGRES_PASSWORD=<generate-a-strong-password>
INITIAL_PASSWORD=<your-login-password>
PUBLIC_IP=<your-elastic-ip>
WEBHOOK_BASE_URL=https://<your-domain-or-ip>:3000
CORS_ORIGIN=https://<your-domain-or-ip>:3000
```

Start everything:

```bash
docker compose up -d
```

Verify:

```bash
docker compose ps
curl http://localhost:3000/health
```

### 5. Enable Auto-Start on Boot

Docker service is already enabled. Containers with `restart: unless-stopped` start automatically when Docker starts. Verify after a reboot:

```bash
sudo reboot
# After reconnecting:
docker compose ps
```

### 6. Set Up CloudWatch Auto-Recovery

This alarm monitors the instance's underlying hardware. If a system status check fails, AWS automatically recovers the instance on healthy hardware — same EBS volume, same Elastic IP, same private IP.

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "svarla-auto-recovery" \
  --namespace "AWS/EC2" \
  --metric-name "StatusCheckFailed_System" \
  --dimensions "Name=InstanceId,Value=i-xxxx" \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions "arn:aws:automate:<region>:ec2:recover"
```

Replace `i-xxxx` with your instance ID and `<region>` with your AWS region.

---

## Backups

### Daily Database Dump to S3

Create an S3 bucket for backups:

```bash
aws s3 mb s3://svarla-backups-<your-account-id>
```

Create the backup script on the instance at `~/svarla/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/tmp/svarla-backup"
S3_BUCKET="s3://svarla-backups-<your-account-id>"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="svarla-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Dump from the running Postgres container
docker compose -f ~/svarla/docker-compose.yml exec -T db \
  pg_dump -U svarla --format=plain svarla | gzip > "${BACKUP_DIR}/${FILENAME}"

# Upload to S3
aws s3 cp "${BACKUP_DIR}/${FILENAME}" "${S3_BUCKET}/daily/${FILENAME}"

# Clean up local temp
rm -f "${BACKUP_DIR}/${FILENAME}"

echo "Backup uploaded: ${S3_BUCKET}/daily/${FILENAME}"
```

```bash
chmod +x ~/svarla/backup.sh
```

Add a cron job (runs daily at 03:00 UTC):

```bash
crontab -e
```

```
0 3 * * * /home/ec2-user/svarla/backup.sh >> /home/ec2-user/svarla/backup.log 2>&1
```

### S3 Lifecycle Policy (Retention)

Keep daily backups for 14 days, then delete automatically:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket svarla-backups-<your-account-id> \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-old-backups",
      "Status": "Enabled",
      "Filter": {"Prefix": "daily/"},
      "Expiration": {"Days": 14}
    }]
  }'
```

### EBS Snapshots (Full Volume Backup)

Use AWS Data Lifecycle Manager to snapshot the EBS volume daily and retain 7 snapshots:

1. Go to **EC2 → Lifecycle Manager → Create lifecycle policy**
2. Target: volumes tagged `Name=svarla-data` (tag your volume)
3. Schedule: daily, retain 7 snapshots
4. Enable cross-region copy if you want geographic redundancy (adds cost)

Or via CLI:

```bash
# Tag the volume first
aws ec2 create-tags --resources vol-xxxx --tags Key=Name,Value=svarla-data

# Create DLM policy
aws dlm create-lifecycle-policy \
  --description "Svarla daily EBS snapshots" \
  --state ENABLED \
  --execution-role-arn arn:aws:iam::<account-id>:role/AWSDataLifecycleManagerDefaultRole \
  --policy-details '{
    "PolicyType": "EBS_SNAPSHOT_MANAGEMENT",
    "ResourceTypes": ["VOLUME"],
    "TargetTags": [{"Key": "Name", "Value": "svarla-data"}],
    "Schedules": [{
      "Name": "daily",
      "CreateRule": {"Interval": 24, "IntervalUnit": "HOURS", "Times": ["04:00"]},
      "RetainRule": {"Count": 7}
    }]
  }'
```

---

## TLS (Optional but Recommended)

### Option A: Caddy on the Instance

Add Caddy as a container alongside Svarla. The repo already has a `docker-compose.caddy.yml` overlay for this. Set your `DOMAIN` env var and Caddy handles Let's Encrypt automatically.

Ports change to:
- 443 (HTTPS) → Caddy → Svarla :3000
- 10443 stays direct (WebRTC uses DTLS, no additional TLS needed)

### Option B: Just Use the IP

For personal use, you can skip TLS and access via `http://<elastic-ip>:3000`. The Android app works over plain HTTP for local/personal setups. WebRTC audio is always encrypted via DTLS regardless of whether the signaling layer uses TLS.

---

## Maintenance & Updates

### Updating Svarla

```bash
cd ~/svarla
docker compose pull        # Pull latest images
docker compose up -d       # Restart with new images
```

Active calls will drop during the restart (~5-10 seconds of downtime). The Android client reconnects automatically.

### OS Updates

```bash
sudo dnf update -y
sudo reboot  # If kernel update
```

Containers auto-start after reboot.

### Monitoring

Check container health:

```bash
docker compose ps
docker compose logs --tail=50 svarla
docker compose logs --tail=50 db
```

Set up a simple uptime check (optional):
- AWS Route 53 health check on `http://<elastic-ip>:3000/health`
- Or a free external service like UptimeRobot

---

## Disaster Recovery

### Restoring from pg_dump

```bash
# Download the backup
aws s3 cp s3://svarla-backups-<id>/daily/svarla-20260801-030000.sql.gz /tmp/

# Stop the app container (keep Postgres running)
docker compose stop svarla

# Restore
gunzip /tmp/svarla-20260801-030000.sql.gz
docker compose exec -T db psql -U svarla -d svarla < /tmp/svarla-20260801-030000.sql

# Restart
docker compose up -d
```

### Restoring from EBS Snapshot

If the entire volume is lost:

1. Create a new volume from the most recent snapshot
2. Detach the failed volume, attach the new one
3. Start the instance — Docker + containers come up with the recovered data

### Full Instance Replacement

If the instance is unrecoverable:

1. Launch a new `t4g.small` from the same AMI
2. Attach the EBS volume (from snapshot if needed)
3. Re-associate the Elastic IP
4. SSH in and `docker compose up -d`

Total recovery time: ~10-15 minutes manually.

---

## Security Hardening

- SSH: key-only auth (disable password auth in sshd_config)
- Security group: restrict SSH to your IP or a bastion
- Keep port 5432 bound to 127.0.0.1 (already done in compose file)
- Set `ADMIN_TOKEN` in .env to protect provider management endpoints
- Set `CONFIG_ENCRYPTION_KEY` to encrypt provider secrets at rest
- Run `unattended-upgrades` or equivalent for automatic security patches

---

## Summary

| Concern | Solution |
|---------|----------|
| Compute | EC2 t4g.small ($12/mo) |
| Storage | 30 GB gp3 EBS ($2.40/mo) |
| Static IP | Elastic IP (free) |
| Auto-healing | CloudWatch auto-recovery alarm |
| Database backup | Daily pg_dump → S3 (14-day retention) |
| Volume backup | Daily EBS snapshots (7-day retention) |
| TLS | Caddy container (optional) |
| Recovery time | 2-5 min (auto), 10-15 min (manual) |
| **Total monthly** | **~$15-18** |
