// Module JETABLE : lest de couverture pour constater le chemin négatif du contrôle requis.
// NE PAS FUSIONNER (suivi d'audit, remarque 2). Chargé sans être appelé : chaque fonction
// porte des branches jamais exécutées, pour faire tomber la couverture sous les planchers.

// Variable (non littérale) pour que les branches ci-dessous restent lisibles par ESLint
// (`no-constant-condition` ne signale que les conditions LITTÉRALES).
const jamaisVrai = false;

export function lest0(valeur) {
  if (valeur > 0) {
    if (valeur % 2 === 0) {
      return valeur * 1;
    } else {
      return valeur - 0;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 0;
}

export function lest1(valeur) {
  if (valeur > 1) {
    if (valeur % 2 === 0) {
      return valeur * 2;
    } else {
      return valeur - 1;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 1;
}

export function lest2(valeur) {
  if (valeur > 2) {
    if (valeur % 2 === 0) {
      return valeur * 3;
    } else {
      return valeur - 2;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 2;
}

export function lest3(valeur) {
  if (valeur > 3) {
    if (valeur % 2 === 0) {
      return valeur * 4;
    } else {
      return valeur - 3;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 3;
}

export function lest4(valeur) {
  if (valeur > 4) {
    if (valeur % 2 === 0) {
      return valeur * 5;
    } else {
      return valeur - 4;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 4;
}

export function lest5(valeur) {
  if (valeur > 5) {
    if (valeur % 2 === 0) {
      return valeur * 6;
    } else {
      return valeur - 5;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 5;
}

export function lest6(valeur) {
  if (valeur > 6) {
    if (valeur % 2 === 0) {
      return valeur * 7;
    } else {
      return valeur - 6;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 6;
}

export function lest7(valeur) {
  if (valeur > 7) {
    if (valeur % 2 === 0) {
      return valeur * 8;
    } else {
      return valeur - 7;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 7;
}

export function lest8(valeur) {
  if (valeur > 8) {
    if (valeur % 2 === 0) {
      return valeur * 9;
    } else {
      return valeur - 8;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 8;
}

export function lest9(valeur) {
  if (valeur > 9) {
    if (valeur % 2 === 0) {
      return valeur * 10;
    } else {
      return valeur - 9;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 9;
}

export function lest10(valeur) {
  if (valeur > 10) {
    if (valeur % 2 === 0) {
      return valeur * 11;
    } else {
      return valeur - 10;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 10;
}

export function lest11(valeur) {
  if (valeur > 11) {
    if (valeur % 2 === 0) {
      return valeur * 12;
    } else {
      return valeur - 11;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 11;
}

export function lest12(valeur) {
  if (valeur > 12) {
    if (valeur % 2 === 0) {
      return valeur * 13;
    } else {
      return valeur - 12;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 12;
}

export function lest13(valeur) {
  if (valeur > 13) {
    if (valeur % 2 === 0) {
      return valeur * 14;
    } else {
      return valeur - 13;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 13;
}

export function lest14(valeur) {
  if (valeur > 14) {
    if (valeur % 2 === 0) {
      return valeur * 15;
    } else {
      return valeur - 14;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 14;
}

export function lest15(valeur) {
  if (valeur > 15) {
    if (valeur % 2 === 0) {
      return valeur * 16;
    } else {
      return valeur - 15;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 15;
}

export function lest16(valeur) {
  if (valeur > 16) {
    if (valeur % 2 === 0) {
      return valeur * 17;
    } else {
      return valeur - 16;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 16;
}

export function lest17(valeur) {
  if (valeur > 17) {
    if (valeur % 2 === 0) {
      return valeur * 18;
    } else {
      return valeur - 17;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 17;
}

export function lest18(valeur) {
  if (valeur > 18) {
    if (valeur % 2 === 0) {
      return valeur * 19;
    } else {
      return valeur - 18;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 18;
}

export function lest19(valeur) {
  if (valeur > 19) {
    if (valeur % 2 === 0) {
      return valeur * 20;
    } else {
      return valeur - 19;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 19;
}

export function lest20(valeur) {
  if (valeur > 20) {
    if (valeur % 2 === 0) {
      return valeur * 21;
    } else {
      return valeur - 20;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 20;
}

export function lest21(valeur) {
  if (valeur > 21) {
    if (valeur % 2 === 0) {
      return valeur * 22;
    } else {
      return valeur - 21;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 21;
}

export function lest22(valeur) {
  if (valeur > 22) {
    if (valeur % 2 === 0) {
      return valeur * 23;
    } else {
      return valeur - 22;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 22;
}

export function lest23(valeur) {
  if (valeur > 23) {
    if (valeur % 2 === 0) {
      return valeur * 24;
    } else {
      return valeur - 23;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 23;
}

export function lest24(valeur) {
  if (valeur > 24) {
    if (valeur % 2 === 0) {
      return valeur * 25;
    } else {
      return valeur - 24;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 24;
}

export function lest25(valeur) {
  if (valeur > 25) {
    if (valeur % 2 === 0) {
      return valeur * 26;
    } else {
      return valeur - 25;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 25;
}

export function lest26(valeur) {
  if (valeur > 26) {
    if (valeur % 2 === 0) {
      return valeur * 27;
    } else {
      return valeur - 26;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 26;
}

export function lest27(valeur) {
  if (valeur > 27) {
    if (valeur % 2 === 0) {
      return valeur * 28;
    } else {
      return valeur - 27;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 27;
}

export function lest28(valeur) {
  if (valeur > 28) {
    if (valeur % 2 === 0) {
      return valeur * 29;
    } else {
      return valeur - 28;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 28;
}

export function lest29(valeur) {
  if (valeur > 29) {
    if (valeur % 2 === 0) {
      return valeur * 30;
    } else {
      return valeur - 29;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 29;
}

export function lest30(valeur) {
  if (valeur > 30) {
    if (valeur % 2 === 0) {
      return valeur * 31;
    } else {
      return valeur - 30;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 30;
}

export function lest31(valeur) {
  if (valeur > 31) {
    if (valeur % 2 === 0) {
      return valeur * 32;
    } else {
      return valeur - 31;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 31;
}

export function lest32(valeur) {
  if (valeur > 32) {
    if (valeur % 2 === 0) {
      return valeur * 33;
    } else {
      return valeur - 32;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 32;
}

export function lest33(valeur) {
  if (valeur > 33) {
    if (valeur % 2 === 0) {
      return valeur * 34;
    } else {
      return valeur - 33;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 33;
}

export function lest34(valeur) {
  if (valeur > 34) {
    if (valeur % 2 === 0) {
      return valeur * 35;
    } else {
      return valeur - 34;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 34;
}

export function lest35(valeur) {
  if (valeur > 35) {
    if (valeur % 2 === 0) {
      return valeur * 36;
    } else {
      return valeur - 35;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 35;
}

export function lest36(valeur) {
  if (valeur > 36) {
    if (valeur % 2 === 0) {
      return valeur * 37;
    } else {
      return valeur - 36;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 36;
}

export function lest37(valeur) {
  if (valeur > 37) {
    if (valeur % 2 === 0) {
      return valeur * 38;
    } else {
      return valeur - 37;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 37;
}

export function lest38(valeur) {
  if (valeur > 38) {
    if (valeur % 2 === 0) {
      return valeur * 39;
    } else {
      return valeur - 38;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 38;
}

export function lest39(valeur) {
  if (valeur > 39) {
    if (valeur % 2 === 0) {
      return valeur * 40;
    } else {
      return valeur - 39;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 39;
}

export function lest40(valeur) {
  if (valeur > 40) {
    if (valeur % 2 === 0) {
      return valeur * 41;
    } else {
      return valeur - 40;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 40;
}

export function lest41(valeur) {
  if (valeur > 41) {
    if (valeur % 2 === 0) {
      return valeur * 42;
    } else {
      return valeur - 41;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 41;
}

export function lest42(valeur) {
  if (valeur > 42) {
    if (valeur % 2 === 0) {
      return valeur * 43;
    } else {
      return valeur - 42;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 42;
}

export function lest43(valeur) {
  if (valeur > 43) {
    if (valeur % 2 === 0) {
      return valeur * 44;
    } else {
      return valeur - 43;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 43;
}

export function lest44(valeur) {
  if (valeur > 44) {
    if (valeur % 2 === 0) {
      return valeur * 45;
    } else {
      return valeur - 44;
    }
  } else if (valeur < 0) {
    return -valeur;
  }
  return valeur + 44;
}

// Branches JETABLES exécutées au chargement, avec un côté jamais atteint (constat de couverture).
if (jamaisVrai) globalThis.__jetableInerte0_0 = 0;
if (jamaisVrai) globalThis.__jetableInerte0_1 = 1;
if (jamaisVrai) globalThis.__jetableInerte0_2 = 2;
if (jamaisVrai) globalThis.__jetableInerte0_3 = 3;
if (jamaisVrai) globalThis.__jetableInerte0_4 = 4;
if (jamaisVrai) globalThis.__jetableInerte0_5 = 5;
if (jamaisVrai) globalThis.__jetableInerte0_6 = 6;
if (jamaisVrai) globalThis.__jetableInerte0_7 = 7;
if (jamaisVrai) globalThis.__jetableInerte0_8 = 8;
if (jamaisVrai) globalThis.__jetableInerte0_9 = 9;
if (jamaisVrai) globalThis.__jetableInerte0_10 = 10;
if (jamaisVrai) globalThis.__jetableInerte0_11 = 11;
if (jamaisVrai) globalThis.__jetableInerte0_12 = 12;
if (jamaisVrai) globalThis.__jetableInerte0_13 = 13;
if (jamaisVrai) globalThis.__jetableInerte0_14 = 14;
if (jamaisVrai) globalThis.__jetableInerte0_15 = 15;
if (jamaisVrai) globalThis.__jetableInerte0_16 = 16;
if (jamaisVrai) globalThis.__jetableInerte0_17 = 17;
if (jamaisVrai) globalThis.__jetableInerte0_18 = 18;
if (jamaisVrai) globalThis.__jetableInerte0_19 = 19;
if (jamaisVrai) globalThis.__jetableInerte0_20 = 20;
if (jamaisVrai) globalThis.__jetableInerte0_21 = 21;
if (jamaisVrai) globalThis.__jetableInerte0_22 = 22;
if (jamaisVrai) globalThis.__jetableInerte0_23 = 23;
if (jamaisVrai) globalThis.__jetableInerte0_24 = 24;
if (jamaisVrai) globalThis.__jetableInerte0_25 = 25;
if (jamaisVrai) globalThis.__jetableInerte0_26 = 26;
if (jamaisVrai) globalThis.__jetableInerte0_27 = 27;
if (jamaisVrai) globalThis.__jetableInerte0_28 = 28;
if (jamaisVrai) globalThis.__jetableInerte0_29 = 29;
if (jamaisVrai) globalThis.__jetableInerte0_30 = 30;
if (jamaisVrai) globalThis.__jetableInerte0_31 = 31;
if (jamaisVrai) globalThis.__jetableInerte0_32 = 32;
if (jamaisVrai) globalThis.__jetableInerte0_33 = 33;
if (jamaisVrai) globalThis.__jetableInerte0_34 = 34;
if (jamaisVrai) globalThis.__jetableInerte0_35 = 35;
if (jamaisVrai) globalThis.__jetableInerte0_36 = 36;
if (jamaisVrai) globalThis.__jetableInerte0_37 = 37;
if (jamaisVrai) globalThis.__jetableInerte0_38 = 38;
if (jamaisVrai) globalThis.__jetableInerte0_39 = 39;
if (jamaisVrai) globalThis.__jetableInerte0_40 = 40;
if (jamaisVrai) globalThis.__jetableInerte0_41 = 41;
if (jamaisVrai) globalThis.__jetableInerte0_42 = 42;
if (jamaisVrai) globalThis.__jetableInerte0_43 = 43;
if (jamaisVrai) globalThis.__jetableInerte0_44 = 44;
if (jamaisVrai) globalThis.__jetableInerte0_45 = 45;
if (jamaisVrai) globalThis.__jetableInerte0_46 = 46;
if (jamaisVrai) globalThis.__jetableInerte0_47 = 47;
if (jamaisVrai) globalThis.__jetableInerte0_48 = 48;
if (jamaisVrai) globalThis.__jetableInerte0_49 = 49;
if (jamaisVrai) globalThis.__jetableInerte0_50 = 50;
if (jamaisVrai) globalThis.__jetableInerte0_51 = 51;
if (jamaisVrai) globalThis.__jetableInerte0_52 = 52;
if (jamaisVrai) globalThis.__jetableInerte0_53 = 53;
if (jamaisVrai) globalThis.__jetableInerte0_54 = 54;
if (jamaisVrai) globalThis.__jetableInerte0_55 = 55;
if (jamaisVrai) globalThis.__jetableInerte0_56 = 56;
if (jamaisVrai) globalThis.__jetableInerte0_57 = 57;
if (jamaisVrai) globalThis.__jetableInerte0_58 = 58;
if (jamaisVrai) globalThis.__jetableInerte0_59 = 59;
if (jamaisVrai) globalThis.__jetableInerte0_60 = 60;
if (jamaisVrai) globalThis.__jetableInerte0_61 = 61;
if (jamaisVrai) globalThis.__jetableInerte0_62 = 62;
if (jamaisVrai) globalThis.__jetableInerte0_63 = 63;
if (jamaisVrai) globalThis.__jetableInerte0_64 = 64;
if (jamaisVrai) globalThis.__jetableInerte0_65 = 65;
if (jamaisVrai) globalThis.__jetableInerte0_66 = 66;
if (jamaisVrai) globalThis.__jetableInerte0_67 = 67;
if (jamaisVrai) globalThis.__jetableInerte0_68 = 68;
if (jamaisVrai) globalThis.__jetableInerte0_69 = 69;
if (jamaisVrai) globalThis.__jetableInerte0_70 = 70;
if (jamaisVrai) globalThis.__jetableInerte0_71 = 71;
if (jamaisVrai) globalThis.__jetableInerte0_72 = 72;
if (jamaisVrai) globalThis.__jetableInerte0_73 = 73;
if (jamaisVrai) globalThis.__jetableInerte0_74 = 74;
if (jamaisVrai) globalThis.__jetableInerte0_75 = 75;
if (jamaisVrai) globalThis.__jetableInerte0_76 = 76;
if (jamaisVrai) globalThis.__jetableInerte0_77 = 77;
if (jamaisVrai) globalThis.__jetableInerte0_78 = 78;
if (jamaisVrai) globalThis.__jetableInerte0_79 = 79;
if (jamaisVrai) globalThis.__jetableInerte0_80 = 80;
if (jamaisVrai) globalThis.__jetableInerte0_81 = 81;
if (jamaisVrai) globalThis.__jetableInerte0_82 = 82;
if (jamaisVrai) globalThis.__jetableInerte0_83 = 83;
if (jamaisVrai) globalThis.__jetableInerte0_84 = 84;
if (jamaisVrai) globalThis.__jetableInerte0_85 = 85;
if (jamaisVrai) globalThis.__jetableInerte0_86 = 86;
if (jamaisVrai) globalThis.__jetableInerte0_87 = 87;
if (jamaisVrai) globalThis.__jetableInerte0_88 = 88;
if (jamaisVrai) globalThis.__jetableInerte0_89 = 89;
if (jamaisVrai) globalThis.__jetableInerte0_90 = 90;
if (jamaisVrai) globalThis.__jetableInerte0_91 = 91;
if (jamaisVrai) globalThis.__jetableInerte0_92 = 92;
if (jamaisVrai) globalThis.__jetableInerte0_93 = 93;
if (jamaisVrai) globalThis.__jetableInerte0_94 = 94;
if (jamaisVrai) globalThis.__jetableInerte0_95 = 95;
if (jamaisVrai) globalThis.__jetableInerte0_96 = 96;
if (jamaisVrai) globalThis.__jetableInerte0_97 = 97;
if (jamaisVrai) globalThis.__jetableInerte0_98 = 98;
if (jamaisVrai) globalThis.__jetableInerte0_99 = 99;
