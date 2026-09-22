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

/**
 * High-Performance Chunked Daily ROI & Level Commission Payout Engine.
 * Supports scaling up to Millions of Users using Cursor Batching and Event Loop Micro-pauses.
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
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
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
          if (investment.lastRoiDate === todayStr) {
            await t.rollback();
            skippedUsersCount++;
            continue;
          }

          const numActive = Number(investment.activeInvestment || 0);
          const dailyRoi = Number((numActive * dailyRoiRate).toFixed(2));

          if (dailyRoi <= 0) {
            await t.rollback();
            skippedUsersCount++;
            continue;
          }

          // 1. Credit Daily ROI to User's ROI Balance
          investment.roiBalance = Number(investment.roiBalance || 0) + dailyRoi;
          investment.lastRoiDate = todayStr;
          await investment.save({ transaction: t });

          // Log Daily ROI Transaction
          await InvestmentTransaction.create(
            {
              userId: investment.userId,
              type: "DAILY_ROI",
              amount: dailyRoi,
              description: `Daily ROI payout of ₹${dailyRoi.toLocaleString("en-IN")} (${(dailyRoiRate * 100).toFixed(4)}%/day on active ₹${numActive.toLocaleString("en-IN")})`,
              meta: {
                date: todayStr,
                activeInvestment: numActive,
                monthlyRoiPct,
                dailyRoiRate,
              },
            },
            { transaction: t }
          );

          totalRoiDistributed += dailyRoi;

          // 2. Traversal Upline 4-Levels for Daily Level Commissions
          const investorUserNode = await User.findByPk(investment.userId, {
            attributes: ["id", "name", "userID"],
            transaction: t,
          });

          let currentUserId = investment.userId;

          for (let level = 1; level <= 4; level++) {
            const currentUserNode = await User.findByPk(currentUserId, {
              attributes: ["id", "sponsorId", "name", "userID"],
              transaction: t,
            });

            if (!currentUserNode || !currentUserNode.sponsorId) {
              break; // Reached top of tree
            }

            const sponsor = await User.findByPk(currentUserNode.sponsorId, {
              transaction: t,
              lock: t.LOCK.UPDATE,
            });

            if (!sponsor) {
              break;
            }

            const rate = rates[level] || 0;
            if (rate > 0) {
              // Idempotency check: verify if level commission from this investor for today was already credited to this sponsor
              const existingComm = await InvestmentTransaction.findOne({
                where: {
                  userId: sponsor.id,
                  type: "DAILY_LEVEL_COMMISSION",
                  fromUserId: investment.userId,
                  level,
                  "meta.date": todayStr,
                },
                transaction: t,
              });

              if (!existingComm) {
                const commAmount = Number((numActive * (rate / 30)).toFixed(2));

                if (commAmount > 0) {
                  let [sponsorInvestment] = await Investment.findOrCreate({
                    where: { userId: sponsor.id },
                    defaults: {
                      totalInvested: 0,
                      activeInvestment: 0,
                      roiBalance: 0,
                      commissionBalance: 0,
                      totalWithdrawn: 0,
                      status: "ACTIVE",
                    },
                    transaction: t,
                    lock: t.LOCK.UPDATE,
                  });

                  sponsorInvestment.commissionBalance = Number(sponsorInvestment.commissionBalance || 0) + commAmount;
                  await sponsorInvestment.save({ transaction: t });

                  const fromName = investorUserNode ? investorUserNode.name : currentUserNode.name;
                  const fromUserID = investorUserNode ? investorUserNode.userID : currentUserNode.userID;

                  await InvestmentTransaction.create(
                    {
                      userId: sponsor.id,
                      type: "DAILY_LEVEL_COMMISSION",
                      amount: commAmount,
                      level,
                      fromUserId: investment.userId,
                      description: `Level ${level} Daily Commission (${(rate * 100).toFixed(2)}% monthly) from ${fromName} (${fromUserID}) active investment of ₹${numActive.toLocaleString("en-IN")}`,
                      meta: {
                        date: todayStr,
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
            }

            currentUserId = sponsor.id;
          }

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
      `[DailyPayoutEngine] ✅ Completed for ${todayStr}. Processed: ${processedUsersCount}, Skipped: ${skippedUsersCount}, Total ROI: ₹${totalRoiDistributed}, Total Comm: ₹${totalCommissionsDistributed}`
    );

    return {
      success: true,
      date: todayStr,
      processedUsersCount,
      skippedUsersCount,
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
