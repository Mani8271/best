import { Op } from "sequelize";
import PairMatch from "../models/PairMatch.js";
import RankSetting from "../models/RankSetting.js";
import RankAchievement from "../models/RankAchievement.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

async function creditAward({ userId, amount, meta, t }) {
  if (Number(amount || 0) <= 0) return null;

  const wallet = await Wallet.findOne({
    where: { userId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!wallet) throw new Error("Wallet not found");

  wallet.balance = Number(wallet.balance || 0) + Number(amount || 0);
  wallet.totalBalance = Number(wallet.balance || 0) + Number(wallet.lockedBalance || 0);
  await wallet.save({ transaction: t });

  const txn = await WalletTransaction.create(
    {
      walletId: wallet.id,
      type: "CREDIT",
      amount,
      reason: "AWARD_REWARD",
      meta: meta || null,
    },
    { transaction: t }
  );

  return txn;
}

export async function checkAndGrantAwards({ userId, t }) {
  // total matched pairs (ceiling applied ones)
  const totalPairs = await PairMatch.count({
    where: { uplineUserId: userId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const settings = await RankSetting.findAll({
    where: { isActive: true, pairsRequired: { [Op.lte]: totalPairs } },
    order: [["pairsRequired", "ASC"]],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  let granted = 0;

  for (const s of settings) {
    const already = await RankAchievement.findOne({
      where: { userId, pairsRequired: s.pairsRequired },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (already) continue;

    const ach = await RankAchievement.create(
      {
        userId,
        pairsRequired: s.pairsRequired,
        pairsAtTime: totalPairs,
        cashReward: s.cashReward,
        giftName: s.giftName || null,
        giftStatus: s.giftName ? "PENDING" : "DELIVERED",
        achievedAt: new Date(),
      },
      { transaction: t }
    );

    const txn = await creditAward({
      userId,
      amount: Number(s.cashReward || 0),
      meta: {
        pairsRequired: s.pairsRequired,
        pairsAtTime: totalPairs,
        giftName: s.giftName || null,
        achievementId: ach.id,
      },
      t,
    });

    if (txn) await ach.update({ walletTransactionId: txn.id }, { transaction: t });

    granted += 1;
  }

  return { totalPairs, granted };
}
