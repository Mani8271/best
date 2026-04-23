import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";
import bcrypt from "bcryptjs";

const User = sequelize.define("User", {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false },
  phone: { type: DataTypes.STRING, allowNull: false },
  password: { type: DataTypes.STRING, allowNull: false },

  role: {
    type: DataTypes.ENUM("USER", "ADMIN", "MASTER", "STAFF"),
    allowNull: false,
    defaultValue: "USER",
  },

  userType: {
    type: DataTypes.ENUM("TRAINEE_ENTREPRENEUR", "ENTREPRENEUR"),
    allowNull: false,
    defaultValue: "TRAINEE_ENTREPRENEUR",
  },

  profilePic: { type: DataTypes.STRING, allowNull: true },

  userID: { type: DataTypes.STRING(12), allowNull: false, unique: true },

  referralCode: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  sponsorId: { type: DataTypes.INTEGER, allowNull: true },

  leftCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  rightCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  leftEntCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  rightEntCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  paidPairs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  unlockedPairsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // specifically for entrepreneurs
  sponsorPaidPairs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

  // Bank Details
  bankAccountNumber: { type: DataTypes.STRING, allowNull: true },
  ifscCode: { type: DataTypes.STRING, allowNull: true },
  accountHolderName: { type: DataTypes.STRING, allowNull: true },
  panNumber: { type: DataTypes.STRING, allowNull: true },
  upiId: { type: DataTypes.STRING, allowNull: true },

  gender: {
    type: DataTypes.ENUM("MALE", "FEMALE", "OTHER"),
    allowNull: true,
  },
  dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
  activationDate: { type: DataTypes.DATE, allowNull: true },

  bankPhoto: { type: DataTypes.STRING, allowNull: true },
  panPhoto: { type: DataTypes.STRING, allowNull: true },
  aadharPhoto: { type: DataTypes.STRING, allowNull: true },

  bankName: { type: DataTypes.STRING, allowNull: true },
  bankBranch: { type: DataTypes.STRING, allowNull: true },
  bankAccountType: { type: DataTypes.STRING, allowNull: true },
  adharNumber: { type: DataTypes.STRING, allowNull: true },

  // Nominee Details
  nomineeName: { type: DataTypes.STRING, allowNull: true },
  nomineeRelation: { type: DataTypes.STRING, allowNull: true },
  nomineePhone: { type: DataTypes.STRING, allowNull: true },

  status: {
    type: DataTypes.ENUM("ACTIVE", "INACTIVE"),
    allowNull: false,
    defaultValue: "ACTIVE",
  },
}, {
  indexes: [
    { fields: ["sponsorId"] },
  ]
});

const generateNumericUserID = () => {
  const num = Math.floor(100000 + Math.random() * 900000); // 6 digits
  return `S${num}`;
};
// ✅ generate userID BEFORE validation
User.beforeValidate(async (user, options) => {
  if (!user.userID) {
    let isUnique = false;

    while (!isUnique) {
      const tempId = generateNumericUserID();

      const exists = await User.findOne({
        where: { userID: tempId },
        transaction: options?.transaction,
      });

      if (!exists) {
        user.userID = tempId;
        isUnique = true;
      }
    }
  }
});



export default User;
