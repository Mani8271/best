const { sequelize } = require("../config/db.js");
const { Op } = require("sequelize");
const User = require("../models/User.js");
const Investment = require("../models/Investment.js");
const InvestmentTransaction = require("../models/InvestmentTransaction.js");
const { getSettingNumber } = require("../config/settings.js");

/**
 * Helper utility to yield execution back to Node's Event Loop between batches.
 * Prevents server API freezing / latency spikes during bulk processing.
 */
const sleep = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// Max number of missed days (server downtime) that will be back-filled for one investment
const MAX_CATCHUP_DAYS = 31;

const toIstDateStr = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Dates (YYYY-MM-DD, IST) still unpaid for an investment: every day after lastRoiDate up to today.
 * First-ever payout (no lastRoiDate) pays today only.
 */
function getPendingDates(lastRoiDate, todayStr) {
  if (!lastRoiDate) return [todayStr];
  if (lastRoiDate >= todayStr) return [];

  const dates = [];
  let d = addDays(lastRoiDate, 1);
  while (d <= todayStr) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates.slice(-MAX_CATCHUP_DAYS);
}

const isBlocked = (user) => !user || user.status === "INACTIVE_BY_ADMIN";

/**
 * High-Performance Chunked Daily ROI & Level Commission Payout Engine.
 * Supports scaling up to Millions of Users using Cursor Batching and Event Loop Micro-pauses.
 *
 * Rules:
 *  - Investors blocked by admin (INACTIVE_BY_ADMIN) earn no ROI and generate no level commissions.
 *  - Upline sponsors receive level commission only if they are not blocked and have activeInvestment > 0.
 *    An ineligible sponsor's level share is skipped (not passed up); traversal continues to the next level.
 *  - Days missed because the server was down are back-filled (max MAX_CATCHUP_DAYS), using the
 *    investment amount that was active on each of those days.
 */
let isPayoutEngineRunning = false;

async function processDailyPayouts(batchSize = 500) {
  if (isPayoutEngineRunning) {
    console.log("[DailyPayoutEngine] ⚠️ Payout processing is already running. Skipping concurrent call.");
    return { success: false, msg: "Payout process already in progress" };
  }
  isPayoutEngineRunning = true;

  try {
    // Get YYYY-MM-DD in Indian Standard Time (Asia/Kolkata)
    const todayStr = toIstDateStr(new Date());
    console.log(`[DailyPayoutEngine] 🚀 Starting Chunked Daily ROI Processing for date: ${todayStr} (Batch Size: ${batchSize})`);

    // Fetch dynamic settings
    const monthlyRoiPct = await getSettingNumber("INVESTMENT_ROI_PERCENT", 5);
    const level1Pct = await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 2);
    const level2Pct = await getSettingNumber("INVESTMENT_LEVEL_2_PERCENT", 1.5);
    const level3Pct = await getSettingNumber("INVESTMENT_LEVEL_3_PERCENT", 1.0);
    const level4Pct = await getSettingNumber("INVESTMENT_LEVEL_4_PERCENT", 0.5);

    // Daily ROI rate = (Monthly ROI %) / 30 / 100
    const dailyRoiRate = monthlyRoiPct / 30 / 100;

    const rates = {
      1: level1Pct / 100,
      2: level2Pct / 100,
      3: level3Pct / 100,
      4: level4Pct / 100,
    };

    let processedUsersCount = 0;
    let skippedUsersCount = 0;
    let blockedUsersCount = 0;
    let catchUpDaysCount = 0;
    let totalRoiDistributed = 0;
    let totalCommissionsDistributed = 0;
    const errors = [];

    let lastProcessedId = 0;
    let hasMoreRecords = true;

    while (hasMoreRecords) {
      // Fetch investments in chunks of batchSize ordered by ID ascending
      const batch = await Investment.findAll({
        where: {
          id: { [Op.gt]: lastProcessedId },
          status: "ACTIVE",
          activeInvestment: { [Op.gt]: 0 },
        },
        order: [["id", "ASC"]],
        limit: batchSize,
      });

      if (batch.length === 0) {
        hasMoreRecords = false;
        break;
      }

      console.log(`[DailyPayoutEngine] Processing batch of ${batch.length} records (Last ID: ${lastProcessedId})...`);

      for (const investmentItem of batch) {
        lastProcessedId = investmentItem.id;

        const t = await sequelize.transaction();
        try {
          // Row-level DB lock & fresh fetch inside transaction to eliminate race conditions
          const investment = await Investment.findByPk(investmentItem.id, {
            transaction: t,
            lock: t.LOCK.UPDATE,
          });

          if (!investment || investment.status !== "ACTIVE" || Number(investment.activeInvestment || 0) <= 0) {
            await t.rollback();
            skippedUsersCount++;
            continue;
          }

          // Strict double-run check on fresh DB record
          const pendingDates = getPendingDates(investment.lastRoiDate, todayStr);
          if (pendingDates.length === 0) {
            await t.rollback();
            skippedUsersCount++;
            continue;
          }

          const investorUserNode = await User.findByPk(investment.userId, {
            attributes: ["id", "name", "userID", "status", "sponsorId"],
            transaction: t,
          });

          // Blocked investor: no ROI, no upline commission. Advance lastRoiDate so blocked days are never back-paid.
          if (isBlocked(investorUserNode)) {
            investment.lastRoiDate = todayStr;
            await investment.save({ transaction: t });
            await t.commit();
            blockedUsersCount++;
            continue;
          }

          const currentActive = Number(investment.activeInvestment || 0);

          // Deposits made after a back-filled day must not earn for that day
          const laterDeposits = pendingDates.length > 1
            ? await InvestmentTransaction.findAll({
              where: { userId: investment.userId, type: "DEPOSIT" },
              attributes: ["amount", "createdAt"],
              transaction: t,
            })
            : [];
          const activeOn = (dateStr) => {
            if (dateStr === todayStr) return currentActive;
            const depositedLater = laterDeposits
              .filter((d) => toIstDateStr(d.createdAt) > dateStr)
              .reduce((sum, d) => sum + Number(d.amount || 0), 0);
            return Math.max(0, currentActive - depositedLater);
          };

          // Resolve 4-level upline once and check each sponsor's eligibility
          const uplines = [];
          let currentUserNode = investorUserNode;
          for (let level = 1; level <= 4; level++) {
            if (!currentUserNode || !currentUserNode.sponsorId) break; // Reached top of tree

            const sponsor = await User.findByPk(currentUserNode.sponsorId, {
              attributes: ["id", "name", "userID", "status", "sponsorId"],
              transaction: t,
              lock: t.LOCK.UPDATE,
            });
            if (!sponsor) break;

            const sponsorInvestment = await Investment.findOne({
              where: { userId: sponsor.id },
              transaction: t,
              lock: t.LOCK.UPDATE,
            });

            const eligible =
              !isBlocked(sponsor) &&
              sponsorInvestment &&
              sponsorInvestment.status === "ACTIVE" &&
              Number(sponsorInvestment.activeInvestment || 0) > 0;

            uplines.push({ level, sponsor, sponsorInvestment: eligible ? sponsorInvestment : null });
            currentUserNode = sponsor;
          }

          const fromName = investorUserNode.name;
          const fromUserID = investorUserNode.userID;

          for (const dateStr of pendingDates) {
            const numActive = activeOn(dateStr);
            const dailyRoi = Number((numActive * dailyRoiRate).toFixed(2));
            if (dailyRoi <= 0) continue;

            // 1. Credit Daily ROI to User's ROI Balance
            investment.roiBalance = Number(investment.roiBalance || 0) + dailyRoi;

            // Log Daily ROI Transaction
            await InvestmentTransaction.create(
              {
                userId: investment.userId,
                type: "DAILY_ROI",
                amount: dailyRoi,
                description: `Daily ROI payout of ₹${dailyRoi.toLocaleString("en-IN")} (${(dailyRoiRate * 100).toFixed(4)}%/day on active ₹${numActive.toLocaleString("en-IN")})${dateStr !== todayStr ? ` for ${dateStr}` : ""}`,
                meta: {
                  date: dateStr,
                  activeInvestment: numActive,
                  monthlyRoiPct,
                  dailyRoiRate,
                  ...(dateStr !== todayStr ? { catchUp: true } : {}),
                },
              },
              { transaction: t }
            );

            totalRoiDistributed += dailyRoi;
            if (dateStr !== todayStr) catchUpDaysCount++;

            // 2. Daily Level Commissions to eligible upline sponsors
            for (const { level, sponsor, sponsorInvestment } of uplines) {
              const rate = rates[level] || 0;
              if (rate <= 0 || !sponsorInvestment) continue;

              // Idempotency check: verify if level commission from this investor for this date was already credited to this sponsor
              const existingComm = await InvestmentTransaction.findOne({
                where: {
                  userId: sponsor.id,
                  type: "DAILY_LEVEL_COMMISSION",
                  fromUserId: investment.userId,
                  level,
                  "meta.date": dateStr,
                },
                transaction: t,
              });
              if (existingComm) continue;

              const commAmount = Number((numActive * (rate / 30)).toFixed(2));
              if (commAmount <= 0) continue;

              sponsorInvestment.commissionBalance = Number(sponsorInvestment.commissionBalance || 0) + commAmount;
              await sponsorInvestment.save({ transaction: t });

              await InvestmentTransaction.create(
                {
                  userId: sponsor.id,
                  type: "DAILY_LEVEL_COMMISSION",
                  amount: commAmount,
                  level,
                  fromUserId: investment.userId,
                  description: `Level ${level} Daily Commission (${(rate * 100).toFixed(2)}% monthly) from ${fromName} (${fromUserID}) active investment of ₹${numActive.toLocaleString("en-IN")}${dateStr !== todayStr ? ` for ${dateStr}` : ""}`,
                  meta: {
                    date: dateStr,
                    level,
                    ratePercentage: rate * 100,
                    investorActiveInvestment: numActive,
                    investorUserId: fromUserID,
                    investorName: fromName,
                  },
                },
                { transaction: t }
              );

              totalCommissionsDistributed += commAmount;
            }
          }

          investment.lastRoiDate = todayStr;
          await investment.save({ transaction: t });

          await t.commit();
          processedUsersCount++;
        } catch (err) {
          await t.rollback();
          console.error(`[DailyPayoutEngine] Error processing user ID ${investmentItem.userId}:`, err);
          errors.push({ userId: investmentItem.userId, error: err.message });
        }
      }

      // Micro-pause after each batch to yield event loop & keep HTTP Server fast
      await sleep(20);
    }

    console.log(
      `[DailyPayoutEngine] ✅ Completed for ${todayStr}. Processed: ${processedUsersCount}, Skipped: ${skippedUsersCount}, Blocked: ${blockedUsersCount}, Catch-up days: ${catchUpDaysCount}, Total ROI: ₹${totalRoiDistributed}, Total Comm: ₹${totalCommissionsDistributed}`
    );

    return {
      success: true,
      date: todayStr,
      processedUsersCount,
      skippedUsersCount,
      blockedUsersCount,
      catchUpDaysCount,
      totalRoiDistributed: Number(totalRoiDistributed.toFixed(2)),
      totalCommissionsDistributed: Number(totalCommissionsDistributed.toFixed(2)),
      errors,
    };
  } finally {
    isPayoutEngineRunning = false;
  }
}

module.exports = {
  processDailyPayouts,
};
