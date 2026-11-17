#!/usr/bin/perl
# Kürzt Rufnummern in den Meldungen von Asterisk, bevor sie gespeichert werden
# (Issue #511). Liest die Konsole von Asterisk zeilenweise und schreibt jede
# Zeile gekürzt auf die Standardausgabe (Docker-Log) und an die Datei aus dem
# ersten Argument (logs/messages, für fail2ban).
#
# Gekürzt wird jede Ziffernfolge mit mindestens 7 Ziffern, auch mit Leerzeichen,
# Bindestrichen, Klammern oder Punkten dazwischen: "+4917612345678" wird zu
# "+49176...", "030.123.45.67" zu "03012...". Ob eine Ziffernfolge eine
# Adresse ist, entscheidet allein das Feld, in dem sie steht, nie ihre Form:
# Eine Rufnummer kann wie eine IPv4-Adresse oder ein Datum aussehen. Stehen
# bleiben nur
# - der Zeitstempel am Zeilenanfang,
# - die Absenderadresse in den Feldern, aus denen fail2ban sie liest (Filter
#   "asterisk"): failed for '<adresse>:<port>' und
#   LocalAddress/RemoteAddress="IPV4/<transport>/<adresse>/<port>",
# - der Zeitpunkt eines Sicherheitsereignisses (EventTV="<ISO 8601>").
# Ports haben höchstens 5 Ziffern und bleiben ohnehin stehen.
use strict;
use warnings;

my $IPV4 = qr/\d{1,3}(?:\.\d{1,3}){3}/;

sub kuerze {
    my ($treffer) = @_;
    my $plus = $treffer =~ /^\+/ ? '+' : '';
    (my $ziffern = $treffer) =~ s/\D//g;
    return $plus . substr($ziffern, 0, 5) . '...';
}

sub maskiere {
    my ($zeile) = @_;
    my $kopf = '';
    $kopf = $1 if $zeile =~ s/^(\[[0-9: -]+\]\s*)//;
    # Geschützte Felder werden durch Platzhalter ohne Ziffern ersetzt und nach
    # dem Kürzen zurückgesetzt; \x01 und \x02 aus der Eingabe gelten nicht.
    $zeile =~ tr/\x01\x02/??/;
    my @geschuetzt;
    my $merke = sub { push @geschuetzt, $_[0]; return "\x01" . ('a' x scalar @geschuetzt) . "\x02"; };
    $zeile =~ s/(failed for ')($IPV4)(?=[:'])/$1 . $merke->($2)/ge;
    $zeile =~ s/((?:Local|Remote)Address="IPV4\/[A-Za-z]+\/)($IPV4)(?=\/\d+")/$1 . $merke->($2)/ge;
    $zeile =~ s/(EventTV=")(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d{4})(?=")/$1 . $merke->($2)/ge;
    $zeile =~ s/(\+?\d(?:[-. ()]?\d){6,})/kuerze($1)/ge;
    $zeile =~ s/\x01(a+)\x02/$geschuetzt[length($1) - 1]/ge;
    return $kopf . $zeile;
}

my $datei = shift @ARGV;
my $log;
if (defined $datei && !open($log, '>>', $datei)) {
    print STDERR "logfilter: $datei nicht beschreibbar, Meldungen nur im Docker-Log\n";
    undef $log;
}
$log->autoflush(1) if $log;
STDOUT->autoflush(1);

while (my $zeile = <STDIN>) {
    my $aus = maskiere($zeile);
    print STDOUT $aus;
    print {$log} $aus if $log;
}
