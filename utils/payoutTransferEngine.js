const { sequelize } = require("../config/db.js");
const { Op } = require("sequelize");
const User = require("../models/User.js");
const Wallet = require("../models/Wallet.js");
const WalletTransaction = require("../models/WalletTransaction.js");
const Investment = require("../models/Investment.js");
const InvestmentTransaction = require("../models/InvestmentTransaction.js");
const { getSettingNumber } = require("../config/settings.js");

const sleep = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Bi-Monthly Scheduled Payout Transfer Engine.
 * Transfers accumulated roiBalance & commissionBalance into main Wallet.balance (Available Balance),
 * and resets roiBalance = 0 & commissionBalance = 0 on Investment records.
 */
async function processPayoutTransfers(batchSize = 500) {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  console.log(`[PayoutTransferEngine] 🚀 Starting Scheduled Payout Transfers for date: ${todayStr} (Batch Size: ${batchSize})`);

  let processedCount = 0;
  let skippedCount = 0;
  let totalTransferredAmount = 0;
  const errors = [];

  let lastProcessedId = 0;
  let hasMoreRecords = true;

  while (hasMoreRecords) {
    const batch = await Investment.findAll({
      where: {
        id: { [Op.gt]: lastProcessedId },
        status: "ACTIVE",
        [Op.or]: [
          { roiBalance: { [Op.gt]: 0 } },
          { commissionBalance: { [Op.gt]: 0 } },
        ],
      },
      order: [["id", "ASC"]],
      limit: batchSize,
    });

    if (batch.length === 0) {
      hasMoreRecords = false;
      break;
    }

    console.log(`[PayoutTransferEngine] Processing batch of ${batch.length} transfer records (Last ID: ${lastProcessedId})...`);

    for (const investment of batch) {
      lastProcessedId = investment.id;

      const t = await sequelize.transaction();
      try {
        const roi = round2(investment.roiBalance || 0);
        const comm = round2(investment.commissionBalance || 0);
        const transferTotal = round2(roi + comm);

        if (transferTotal <= 0) {
          await t.rollback();
          skippedCount++;
          continue;
        }

        // 1. Reset roiBalance & commissionBalance on Investment model
        investment.roiBalance = 0.00;
        investment.commissionBalance = 0.00;
        await investment.save({ transaction: t });

        // 2. Find or create user's main Wallet & credit Available Balance
        let [wallet] = await Wallet.findOrCreate({
          where: { userId: investment.userId },
          defaults: {
            userId: investment.userId,
            balance: 0,
            spotBalance: 0,
            lockedBalance: 0,
            totalBalance: 0,
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        const newBal = round2(Number(wallet.balance || 0) + transferTotal);
        const spotBal = Number(wallet.spotBalance || 0);
        const lockedBal = Number(wallet.lockedBalance || 0);

        wallet.balance = newBal;
        wallet.totalBalance = round2(newBal + spotBal + lockedBal);
        await wallet.save({ transaction: t });

        // 3. Log WalletTransaction
        await WalletTransaction.create(
          {
            walletId: wallet.id,
            type: "CREDIT",
            amount: transferTotal,
            reason: "TOPUP",
            status: "APPROVED",
            meta: {
              isPayoutTransfer: true,
              transferredRoi: roi,
              transferredCommission: comm,
              date: todayStr,
            },
          },
          { transaction: t }
        );

        // 4. Log InvestmentTransaction
        await InvestmentTransaction.create(
          {
            userId: investment.userId,
            type: "PAYOUT_TRANSFER",
            amount: transferTotal,
            description: `Scheduled Bi-Monthly Payout Transfer of ₹${transferTotal.toLocaleString("en-IN")} (ROI: ₹${roi.toLocaleString("en-IN")}, Comm: ₹${comm.toLocaleString("en-IN")}) to Available Balance`,
            meta: {
              date: todayStr,
              transferredRoi: roi,
              transferredCommission: comm,
              newAvailableBalance: newBal,
            },
          },
          { transaction: t }
        );

        await t.commit();
        processedCount++;
        totalTransferredAmount = round2(totalTransferredAmount + transferTotal);
      } catch (err) {
        await t.rollback();
        console.error(`[PayoutTransferEngine] Error processing transfer for user ID ${investment.userId}:`, err);
        errors.push({ userId: investment.userId, error: err.message });
      }
    }

    await sleep(20);
  }

  console.log(
    `[PayoutTransferEngine] ✅ Completed for ${todayStr}. Processed: ${processedCount}, Skipped: ${skippedCount}, Total Transferred: ₹${totalTransferredAmount}`
  );

  return {
    success: true,
    date: todayStr,
    processedCount,
    skippedCount,
    totalTransferredAmount,
    errors,
  };
}

module.exports = {
  processPayoutTransfers,
};
